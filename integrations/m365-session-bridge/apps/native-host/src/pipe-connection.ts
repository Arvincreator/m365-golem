import * as net from "node:net";
import {
  resolveIpcPipeName,
  PipeRequestSchema,
  PipeResponseSchema,
  ErrorCode,
  type PipeRequest,
  type PipeResponse,
} from "@m365-bridge/protocol";
import { readSecret } from "@m365-bridge/protocol/secret";
import { defaultSecretPath } from "./paths.js";
import { log } from "./log.js";

/**
 * Client-side connection to the MCP Server's named pipe. The MCP Server is
 * the pipe SERVER (it owns the long-lived process and listens); this native
 * host process is spawned per-Edge-session and connects as a CLIENT,
 * retrying until the server is up. The server pushes PipeRequest commands
 * down this connection; we reply with PipeResponse.
 */
const SECRET_PATH = defaultSecretPath();

export class McpPipeConnection {
  private socket: net.Socket | null = null;
  private buffer = "";
  private stopped = false;
  private connecting = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly onRequest: (req: PipeRequest) => Promise<PipeResponse>) {}

  start(retryIntervalMs = 2000): void {
    this.attempt(retryIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.destroy();
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  private attempt(retryIntervalMs: number): void {
    if (this.stopped || this.socket || this.connecting) return;
    this.connecting = true;
    const secret = readSecret(SECRET_PATH);
    if (!secret) {
      this.connecting = false;
      log(`no secret readable at ${SECRET_PATH}; retrying in ${retryIntervalMs}ms`);
      this.scheduleRetry(retryIntervalMs);
      return;
    }
    const pipeName = resolveIpcPipeName();
    log(`secret found; attempting net.createConnection(${pipeName})`);
    const socket = net.createConnection(pipeName);
    socket.setEncoding("utf8");
    let ended = false;
    socket.on("connect", () => {
      this.connecting = false;
      log(`CONNECTED to ${pipeName}`);
      this.socket = socket;
      socket.write(JSON.stringify({ kind: "hello", role: "native-host" }) + "\n");
    });
    socket.on("data", (chunk: string) => this.onData(chunk));
    const reconnect = (reason: string) => {
      if (ended) return;
      ended = true;
      this.connecting = false;
      log(`disconnected (${reason}); retrying in ${retryIntervalMs}ms`);
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) this.scheduleRetry(retryIntervalMs);
    };
    socket.on("error", (err) => reconnect(`error: ${err.message}`));
    socket.on("close", () => reconnect("close"));
  }

  private scheduleRetry(retryIntervalMs: number): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.attempt(retryIntervalMs);
    }, retryIntervalMs);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) void this.handleLine(line);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const result = PipeRequestSchema.safeParse(parsed);
    if (!result.success) return;
    const req = result.data;

    const expected = readSecret(SECRET_PATH);
    if (!expected || req.secret !== expected) {
      this.reply({
        kind: "response",
        id: req.id,
        ok: false,
        errorCode: ErrorCode.FORBIDDEN_BY_POLICY,
        errorMessage: "Invalid IPC secret",
      });
      return;
    }

    const response = await this.onRequest(req);
    this.reply(response);
  }

  private reply(resp: PipeResponse): void {
    const parsed = PipeResponseSchema.parse(resp);
    this.socket?.write(JSON.stringify(parsed) + "\n");
  }
}
