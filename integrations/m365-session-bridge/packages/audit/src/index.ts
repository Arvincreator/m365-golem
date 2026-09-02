import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import { ensureDir } from "@m365-bridge/files";

export interface AuditEvent {
  timestamp: string;
  operation: string;
  target: string;
  source: string | null;
  destination: string | null;
  fileName: string | null;
  size: number | null;
  result: "success" | "error";
  duration: number;
  requestId: string;
  errorCode: string | null;
}

export class AuditLogger {
  private readonly logFilePath: string;

  constructor(logFilePath: string) {
    this.logFilePath = logFilePath;
  }

  async append(event: AuditEvent): Promise<void> {
    await ensureDir(path.dirname(this.logFilePath));

    const record = {
      timestamp: event.timestamp,
      operation: event.operation,
      target: event.target,
      source: event.source,
      destination: event.destination,
      fileName: event.fileName,
      size: event.size,
      result: event.result,
      duration: event.duration,
      requestId: event.requestId,
      errorCode: event.errorCode,
    };

    const line = JSON.stringify(record) + "\n";
    await fs.promises.appendFile(this.logFilePath, line, "utf8");
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
