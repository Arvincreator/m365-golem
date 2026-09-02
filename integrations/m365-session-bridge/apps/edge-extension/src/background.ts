/**
 * MV3 service worker. Owns the Native Messaging port to the local native
 * host and relays operations to a content script running on an actual
 * SharePoint/OneDrive tab (see content-script.ts for why: SharePoint doesn't
 * emit CORS headers, so the REST calls can't be made from here).
 *
 * This file never calls fetch() against SharePoint itself and never reads
 * chrome.cookies — it only manages tabs, injects the content script, and
 * moves opaque JSON/bytes between the native host and the content script.
 */
import { ErrorCode, NATIVE_MSG_HOST_TO_EXT_MAX_BYTES } from "@m365-bridge/protocol";

const NATIVE_HOST_NAME = "m365_session_bridge";
const RECONNECT_ALARM = "m365-bridge-reconnect";

let port: chrome.runtime.Port | null = null;
const inboundAssembly = new Map<string, { chunks: Uint8Array[]; type: string; payload: Record<string, unknown> }>();

function connect(): chrome.runtime.Port {
  const p = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  p.onMessage.addListener(onNativeMessage);
  p.onDisconnect.addListener(() => {
    port = null;
    // The very first connectNative attempt can fail if the native host wasn't
    // registered yet (e.g. the extension was loaded before running the
    // installer's second pass), or the host process can exit for other
    // reasons. MV3 service workers go dormant and lose any setTimeout state,
    // so a plain retry loop here wouldn't survive — chrome.alarms is the only
    // mechanism that can wake a dormant service worker on a schedule, which
    // is why reconnection is driven by the alarm below instead of retrying
    // inline. Without this, a single failed first attempt would silently
    // leave the bridge offline until the user manually reloaded the extension.
  });
  return p;
}

function getPort(): chrome.runtime.Port {
  if (!port) port = connect();
  return port;
}

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !port) getPort();
});
chrome.runtime.onStartup.addListener(() => getPort());
chrome.runtime.onInstalled.addListener(() => getPort());

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

interface HostToExtMessage {
  v: 1;
  msgId: string;
  chunk?: { index: number; last: boolean };
  type: string;
  payload?: Record<string, unknown>;
  dataBase64?: string;
}

async function onNativeMessage(msg: HostToExtMessage) {
  // Reassemble host->extension chunks (that direction is capped ~1MB per message).
  if (msg.chunk) {
    let entry = inboundAssembly.get(msg.msgId);
    if (!entry) {
      entry = { chunks: [], type: msg.type, payload: msg.payload ?? {} };
      inboundAssembly.set(msg.msgId, entry);
    }
    entry.chunks[msg.chunk.index] = msg.dataBase64 ? base64ToBytes(msg.dataBase64) : new Uint8Array(0);
    if (!msg.chunk.last) return;
    inboundAssembly.delete(msg.msgId);
    const total = entry.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of entry.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    await dispatch(msg.msgId, entry.type, entry.payload, merged);
    return;
  }

  await dispatch(msg.msgId, msg.type, msg.payload ?? {}, msg.dataBase64 ? base64ToBytes(msg.dataBase64) : undefined);
}

function sendChunked(msgId: string, type: string, payload: Record<string, unknown>, data?: Uint8Array) {
  const p = getPort();
  if (!data || data.length === 0) {
    p.postMessage({ v: 1, msgId, type, payload });
    return;
  }
  const chunkSize = NATIVE_MSG_HOST_TO_EXT_MAX_BYTES;
  let offset = 0;
  let index = 0;
  while (offset < data.length) {
    const slice = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    const last = offset + slice.length >= data.length;
    p.postMessage({
      v: 1,
      msgId,
      type,
      payload: index === 0 ? payload : undefined,
      chunk: { index, last },
      dataBase64: bytesToBase64(slice),
    });
    offset += slice.length;
    index += 1;
  }
}

async function findOrCreateTab(originUrl: string): Promise<number> {
  const pattern = `${originUrl.replace(/\/$/, "")}/*`;
  const existing = await chrome.tabs.query({ url: pattern });
  if (existing.length > 0 && existing[0].id) return existing[0].id;

  const tab = await chrome.tabs.create({ url: originUrl, active: false });
  if (!tab.id) throw new Error("Failed to open background tab for " + originUrl);
  await new Promise<void>((resolve) => {
    function listener(tabId: number, info: chrome.tabs.TabChangeInfo) {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab.id;
}

async function relayToContentScript(
  originUrl: string,
  type: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; code?: string; message?: string }> {
  const tabId = await findOrCreateTab(originUrl);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  return chrome.tabs.sendMessage(tabId, { type, payload });
}

function originFromSiteUrl(siteUrl: string): string {
  return new URL(siteUrl).origin;
}

async function dispatch(msgId: string, type: string, payload: Record<string, unknown>, data?: Uint8Array) {
  try {
    if (type === "bridge-status") {
      const siteUrl = payload.siteUrl as string | undefined;
      if (!siteUrl) {
        sendChunked(msgId, "ack", { extensionOnline: true, tabReachable: false });
        return;
      }
      const csResult = await relayToContentScript(originFromSiteUrl(siteUrl), "sp-status", { siteUrl });
      // csResult is the generic content-script {ok, result} shape; spreading
      // it directly would nest the real payload one level under a "result"
      // key that collides with PipeResponse's own "result" wrapper further
      // up the chain, silently hiding `reachable`/`httpStatus` from callers.
      // Flatten explicitly instead.
      const reachableResult = csResult.ok ? (csResult.result as Record<string, unknown>) : { reachable: false };
      sendChunked(msgId, "ack", { extensionOnline: true, ...reachableResult });
      return;
    }

    if (type === "sp-get-file") {
      const csResult = await relayToContentScript(originFromSiteUrl(payload.siteUrl as string), "sp-get-file", payload);
      if (!csResult.ok) {
        sendChunked(msgId, "error", { code: csResult.code, message: csResult.message });
        return;
      }
      const r = csResult.result as { dataBase64: string; size: number };
      sendChunked(msgId, "ack", { size: r.size }, base64ToBytes(r.dataBase64));
      return;
    }

    if (type === "sp-upload-file") {
      const uploadPayload = { ...payload, dataBase64: data ? bytesToBase64(data) : "" };
      const csResult = await relayToContentScript(originFromSiteUrl(payload.siteUrl as string), "sp-upload-file", uploadPayload);
      if (!csResult.ok) {
        sendChunked(msgId, "error", { code: csResult.code, message: csResult.message });
        return;
      }
      sendChunked(msgId, "ack", csResult.result as Record<string, unknown>);
      return;
    }

    if (
      [
        "sp-copy",
        "sp-move",
        "sp-rename",
        "sp-get-url",
        "sp-recycle",
        "sp-create-folder",
        "sp-list-folder",
        "sp-rename-folder",
        "sp-recycle-folder",
        "sp-list-versions",
        "sp-restore-version",
        "sp-checkout",
        "sp-checkin",
        "sp-discard-checkout",
        "sp-update-metadata",
      ].includes(type)
    ) {
      const csResult = await relayToContentScript(originFromSiteUrl(payload.siteUrl as string), type, payload);
      if (!csResult.ok) {
        sendChunked(msgId, "error", { code: csResult.code, message: csResult.message });
        return;
      }
      sendChunked(msgId, "ack", (csResult.result as Record<string, unknown>) ?? {});
      return;
    }

    sendChunked(msgId, "error", { code: ErrorCode.NOT_SUPPORTED_SESSION_BRIDGE, message: `Unknown op: ${type}` });
  } catch (err) {
    sendChunked(msgId, "error", {
      code: ErrorCode.INTERNAL_ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Establish the native messaging connection as soon as the service worker starts.
getPort();
