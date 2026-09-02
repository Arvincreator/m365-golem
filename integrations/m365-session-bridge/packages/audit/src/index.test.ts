import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLogger, newRequestId, AuditEvent } from "./index.js";

function makeTmpLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  return path.join(dir, "nested", "audit.log");
}

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    operation: "upload",
    target: "/some/target",
    source: null,
    destination: null,
    fileName: "file.txt",
    size: 123,
    result: "success",
    duration: 42,
    requestId: newRequestId(),
    errorCode: null,
    ...overrides,
  };
}

test("AuditLogger.append produces one JSON line with exactly the 11 fields", async () => {
  const logPath = makeTmpLogPath();
  const logger = new AuditLogger(logPath);

  await logger.append(makeEvent());

  const content = fs.readFileSync(logPath, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  assert.strictEqual(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.deepStrictEqual(
    Object.keys(parsed).sort(),
    [
      "destination",
      "duration",
      "errorCode",
      "fileName",
      "operation",
      "requestId",
      "result",
      "size",
      "source",
      "target",
      "timestamp",
    ]
  );
});

test("AuditLogger.append is append-only, not overwrite", async () => {
  const logPath = makeTmpLogPath();
  const logger = new AuditLogger(logPath);

  await logger.append(makeEvent({ operation: "upload" }));
  await logger.append(makeEvent({ operation: "download" }));

  const content = fs.readFileSync(logPath, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  assert.strictEqual(lines.length, 2);
});

test("newRequestId returns non-empty strings that differ across calls", () => {
  const id1 = newRequestId();
  const id2 = newRequestId();
  assert.ok(typeof id1 === "string" && id1.length > 0);
  assert.ok(typeof id2 === "string" && id2.length > 0);
  assert.notStrictEqual(id1, id2);
});
