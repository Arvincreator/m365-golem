import * as net from "node:net";
import * as crypto from "node:crypto";
import {
  resolveIpcPipeName,
  PipeHelloSchema,
  PipeProxyRequestSchema,
  PipeResponseSchema,
  type PipeRequest,
  type PipeResponse,
} from "@m365-bridge/protocol";
import { readSecret, writeFreshSecret } from "@m365-bridge/protocol/secret";
import { defaultSecretPath } from "./policy-store.js";

type ServerMode = "starting" | "owner" | "proxy";
type SocketRole = "unknown" | "native-host" | "mcp-proxy";

interface SocketContext {
  socket: net.Socket;
  role: SocketRole;
  buffer: string;
  helloTimer: NodeJS.Timeout;
}

interface PendingEntry {
  resolve: (response: PipeResponse) => void;
  timer: NodeJS.Timeout;
}

const offlineResponse = (message: string): PipeResponse => ({
  kind: "response",
  id: "n/a",
  ok: false,
  errorCode: "BRIDGE_OFFLINE",
  errorMessage: message,
});

/**
 * MCP Server is normally the Named Pipe SERVER; the Edge native host connects
 * as a client. A desktop harness can start more than one MCP process for the
 * same configured server, though, so a later process becomes a local proxy
 * client of the process that owns the pipe. This keeps every MCP instance on
 * the same Edge/native-host connection instead of silently reporting offline.
 */
export class NativeHostServer {
  private readonly server: net.Server;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly proxyPending = new Map<string, PendingEntry>();
  private readonly secretPath = defaultSecretPath();
  private mode: ServerMode = "starting";
  private secret: string | null = null;
  private nativeSocket: net.Socket | null = null;
  private proxySocket: net.Socket | null = null;
  private proxyBuffer = "";
  private proxyConnecting = false;
  private proxyRetryTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  listen(): void {
    this.server.on("error", (err) => {
      if (this.mode === "starting") {
        // Another MCP process already owns the fixed pipe. Become a client of
        // that owner instead of leaving this process with a permanently-null
        // nativeSocket. The owner is responsible for the one Edge connection.
        this.mode = "proxy";
        process.stderr.write(`[m365-bridge] named pipe listen failed; using proxy mode: ${err.message}\n`);
        this.connectToOwner();
        return;
      }
      process.stderr.write(`[m365-bridge] named pipe error: ${err.message}\n`);
    });

    this.server.listen(resolveIpcPipeName(), () => {
      if (this.mode !== "starting") return;
      this.mode = "owner";
      // Rotate the secret only after this process has successfully acquired
      // the pipe. A losing process must never overwrite the owner's secret.
      this.secret = writeFreshSecret(this.secretPath);
    });
  }

  isNativeHostConnected(): boolean {
    if (this.mode === "owner") return this.nativeSocket !== null && !this.nativeSocket.destroyed;
    if (this.mode === "proxy") return this.proxySocket !== null && !this.proxySocket.destroyed;
    return false;
  }

  close(): void {
    if (this.proxyRetryTimer) clearTimeout(this.proxyRetryTimer);
    this.proxyRetryTimer = null;
    this.failPending("Bridge server closed");
    this.failProxyPending("Bridge proxy closed");
    this.nativeSocket?.destroy();
    this.proxySocket?.destroy();
    this.nativeSocket = null;
    this.proxySocket = null;
    if (this.mode === "owner") this.server.close();
    this.mode = "starting";
  }

  private onConnection(socket: net.Socket): void {
    const context: SocketContext = {
      socket,
      role: "unknown",
      buffer: "",
      // Hosts built before the explicit handshake remain compatible. Proxy
      // clients send their hello immediately, while an old native host is
      // otherwise silent until the server sends its first request.
      helloTimer: setTimeout(() => {
        if (context.role === "unknown") {
          context.role = "native-host";
          this.acceptNativeHost(context);
        }
      }, 250),
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onSocketData(context, chunk));
    socket.on("close", () => this.onSocketClose(context));
    socket.on("error", () => {
      // The close event clears the active socket and pending requests.
    });
  }

  private onSocketData(context: SocketContext, chunk: string): void {
    context.buffer += chunk;
    let idx: number;
    while ((idx = context.buffer.indexOf("\n")) >= 0) {
      const line = context.buffer.slice(0, idx);
      context.buffer = context.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (context.role === "unknown") {
        const hello = PipeHelloSchema.safeParse(parsed);
        if (hello.success) {
          clearTimeout(context.helloTimer);
          context.role = hello.data.role;
          if (context.role === "native-host") this.acceptNativeHost(context);
          continue;
        }

        // Backward compatibility for a host built before the handshake fix:
        // the first response on a fresh connection identifies it as native.
        const legacyResponse = PipeResponseSchema.safeParse(parsed);
        if (legacyResponse.success) {
          clearTimeout(context.helloTimer);
          context.role = "native-host";
          this.acceptNativeHost(context);
          this.onNativeResponse(legacyResponse.data);
          continue;
        }
        continue;
      }

      if (context.role === "native-host") {
        const response = PipeResponseSchema.safeParse(parsed);
        if (response.success) this.onNativeResponse(response.data);
        continue;
      }

      const proxyRequest = PipeProxyRequestSchema.safeParse(parsed);
      if (proxyRequest.success) void this.handleProxyRequest(context, proxyRequest.data);
    }
  }

  private acceptNativeHost(context: SocketContext): void {
    if (this.nativeSocket && this.nativeSocket !== context.socket) {
      this.nativeSocket.destroy();
      this.failPending("Edge native host was replaced by a newer connection");
    }
    this.nativeSocket = context.socket;
  }

  private onNativeResponse(response: PipeResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    entry.resolve(response);
  }

  private onSocketClose(context: SocketContext): void {
    clearTimeout(context.helloTimer);
    if (context.role === "native-host" && this.nativeSocket === context.socket) {
      this.nativeSocket = null;
      this.failPending("Edge native host disconnected");
    }
  }

  private failPending(message: string): void {
    const response = offlineResponse(message);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ ...response, id });
    }
  }

  async sendRequest(op: PipeRequest["op"], payload: Record<string, unknown>, timeoutMs = 60_000): Promise<PipeResponse> {
    if (this.mode === "owner") return this.sendDirectRequest(op, payload, timeoutMs);
    if (this.mode === "proxy") return this.sendProxyRequest(op, payload, timeoutMs);
    return offlineResponse("The bridge IPC server is still starting");
  }

  /**
   * The secret FILE is the single source of truth, not this process's cached
   * copy. Observed live as "Invalid IPC secret": this process rotated the
   * secret when it acquired the pipe, but a later MCP process that took
   * ownership after a restart rewrote the file, leaving this process sending
   * a stale in-memory value that the native host (which always reads the
   * file) rightly rejected. Re-reading per send keeps every participant —
   * owner, proxy, and native host — agreeing on whatever was written last.
   */
  private currentSecret(): string | null {
    return readSecret(this.secretPath) ?? this.secret;
  }

  private sendDirectRequest(op: PipeRequest["op"], payload: Record<string, unknown>, timeoutMs: number): Promise<PipeResponse> {
    const socket = this.nativeSocket;
    const secret = this.currentSecret();
    if (!socket || socket.destroyed || !secret) {
      return Promise.resolve(offlineResponse("Native host is not connected"));
    }

    const id = crypto.randomUUID();
    const req: PipeRequest = { kind: "request", id, secret, op, payload };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ kind: "response", id, ok: false, errorCode: "EDGE_EXTENSION_OFFLINE", errorMessage: "Timed out waiting for native host" });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      socket.write(JSON.stringify(req) + "\n");
    });
  }

  private sendProxyRequest(op: PipeRequest["op"], payload: Record<string, unknown>, timeoutMs: number): Promise<PipeResponse> {
    const socket = this.proxySocket;
    const secret = readSecret(this.secretPath);
    if (!socket || socket.destroyed || !secret) {
      return Promise.resolve(offlineResponse("The bridge owner is not connected"));
    }

    const id = crypto.randomUUID();
    const req = { kind: "proxy-request" as const, id, secret, op, payload };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.proxyPending.delete(id)) {
          resolve({ kind: "response", id, ok: false, errorCode: "EDGE_EXTENSION_OFFLINE", errorMessage: "Timed out waiting for bridge owner" });
        }
      }, timeoutMs);
      this.proxyPending.set(id, { resolve, timer });
      socket.write(JSON.stringify(req) + "\n");
    });
  }

  private async handleProxyRequest(context: SocketContext, req: { id: string; secret: string; op: PipeRequest["op"]; payload: Record<string, unknown> }): Promise<void> {
    // Validate against the on-disk secret for the same reason sends read it
    // (see currentSecret): a cached value goes stale as soon as any process
    // rotates the file, which would reject a legitimate proxy.
    const expected = this.currentSecret();
    if (this.mode !== "owner" || !expected) {
      this.writeResponse(context.socket, { ...offlineResponse("Bridge owner is not ready"), id: req.id });
      return;
    }
    if (req.secret !== expected) {
      this.writeResponse(context.socket, {
        kind: "response",
        id: req.id,
        ok: false,
        errorCode: "FORBIDDEN_BY_POLICY",
        errorMessage: "Invalid IPC secret",
      });
      return;
    }

    const response = await this.sendDirectRequest(req.op, req.payload, 60_000);
    this.writeResponse(context.socket, { ...response, id: req.id });
  }

  private writeResponse(socket: net.Socket, response: PipeResponse): void {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
  }

  private connectToOwner(): void {
    if (this.mode !== "proxy" || this.proxySocket || this.proxyConnecting) return;
    this.proxyConnecting = true;
    const socket = net.createConnection(resolveIpcPipeName());
    socket.setEncoding("utf8");
    let ended = false;
    const retry = () => {
      if (ended) return;
      ended = true;
      this.proxyConnecting = false;
      if (this.proxySocket === socket) this.proxySocket = null;
      this.failProxyPending("Bridge owner disconnected");
      if (!this.proxyRetryTimer) {
        this.proxyRetryTimer = setTimeout(() => {
          this.proxyRetryTimer = null;
          this.connectToOwner();
        }, 2000);
      }
    };

    socket.on("connect", () => {
      this.proxyConnecting = false;
      this.proxySocket = socket;
      this.proxyBuffer = "";
      socket.write(JSON.stringify({ kind: "hello", role: "mcp-proxy" }) + "\n");
    });
    socket.on("data", (chunk: string) => this.onProxyData(chunk));
    socket.on("error", () => retry());
    socket.on("close", () => retry());
  }

  private onProxyData(chunk: string): void {
    this.proxyBuffer += chunk;
    let idx: number;
    while ((idx = this.proxyBuffer.indexOf("\n")) >= 0) {
      const line = this.proxyBuffer.slice(0, idx);
      this.proxyBuffer = this.proxyBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const response = PipeResponseSchema.safeParse(parsed);
      if (!response.success) continue;
      const entry = this.proxyPending.get(response.data.id);
      if (!entry) continue;
      this.proxyPending.delete(response.data.id);
      clearTimeout(entry.timer);
      entry.resolve(response.data);
    }
  }

  private failProxyPending(message: string): void {
    const response = offlineResponse(message);
    for (const [id, entry] of this.proxyPending) {
      clearTimeout(entry.timer);
      this.proxyPending.delete(id);
      entry.resolve({ ...response, id });
    }
  }
}
