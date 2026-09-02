import * as crypto from "node:crypto";
import { NATIVE_MSG_HOST_TO_EXT_MAX_BYTES, type NativeMessage } from "@m365-bridge/protocol";
import { writeNativeMessage, NativeMessageReader } from "./framer.js";

export interface ExtensionReply {
  type: string;
  payload?: Record<string, unknown>;
  data?: Buffer;
}

interface PendingEntry {
  resolve: (reply: ExtensionReply) => void;
  chunks: Buffer[];
  timer: NodeJS.Timeout;
}

/**
 * Correlates outgoing commands to the Edge extension (over stdio Native
 * Messaging) with their eventual ack/error reply, reassembling any chunked
 * response along the way. One instance per native-host process.
 */
export class ExtensionLink {
  private pending = new Map<string, PendingEntry>();

  constructor() {
    new NativeMessageReader(process.stdin, (raw) => this.onMessage(raw));
  }

  private onMessage(raw: unknown): void {
    const msg = raw as NativeMessage;
    if (!msg || typeof msg !== "object" || typeof msg.msgId !== "string") return;
    const entry = this.pending.get(msg.msgId);
    if (!entry) return;

    if (msg.chunk) {
      entry.chunks[msg.chunk.index] = msg.dataBase64 ? Buffer.from(msg.dataBase64, "base64") : Buffer.alloc(0);
      if (!msg.chunk.last) return;
    } else if (msg.dataBase64) {
      entry.chunks[0] = Buffer.from(msg.dataBase64, "base64");
    }

    clearTimeout(entry.timer);
    this.pending.delete(msg.msgId);
    const data = entry.chunks.length > 0 ? Buffer.concat(entry.chunks) : undefined;
    entry.resolve({ type: msg.type, payload: msg.payload, data });
  }

  /**
   * Sends one command to the extension, optionally with a binary payload
   * (chunked to respect the host->extension size cap), and resolves with its
   * ack/error reply. Rejects on timeout.
   */
  request(type: string, payload: Record<string, unknown>, data?: Buffer, timeoutMs = 60_000): Promise<ExtensionReply> {
    const msgId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(msgId)) reject(new Error("Timed out waiting for extension response"));
      }, timeoutMs);
      this.pending.set(msgId, { resolve, chunks: [], timer });

      if (!data || data.length === 0) {
        writeNativeMessage(process.stdout, { v: 1, msgId, type, payload });
        return;
      }
      const chunkSize = NATIVE_MSG_HOST_TO_EXT_MAX_BYTES;
      let offset = 0;
      let index = 0;
      while (offset < data.length) {
        const slice = data.subarray(offset, Math.min(offset + chunkSize, data.length));
        const last = offset + slice.length >= data.length;
        writeNativeMessage(process.stdout, {
          v: 1,
          msgId,
          type,
          payload: index === 0 ? payload : undefined,
          chunk: { index, last },
          dataBase64: slice.toString("base64"),
        });
        offset += slice.length;
        index += 1;
      }
    });
  }
}
