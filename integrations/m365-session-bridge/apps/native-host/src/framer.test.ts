import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { writeNativeMessage, NativeMessageReader } from "./framer.js";
import { parseApprovalResult } from "./approval.js";

test("writeNativeMessage/NativeMessageReader round-trip a single message", () => {
  const stream = new PassThrough();
  const received: unknown[] = [];
  new NativeMessageReader(stream, (msg) => received.push(msg));

  writeNativeMessage(stream, { hello: "world", n: 42 });

  assert.deepEqual(received, [{ hello: "world", n: 42 }]);
});

test("NativeMessageReader handles multiple messages split across chunks", () => {
  const stream = new PassThrough();
  const received: unknown[] = [];
  new NativeMessageReader(stream, (msg) => received.push(msg));

  writeNativeMessage(stream, { a: 1 });
  writeNativeMessage(stream, { b: 2 });
  writeNativeMessage(stream, { c: "x".repeat(5000) });

  assert.equal(received.length, 3);
  assert.deepEqual(received[0], { a: 1 });
  assert.deepEqual(received[1], { b: 2 });
  assert.equal((received[2] as { c: string }).c.length, 5000);
});

test("NativeMessageReader tolerates a malformed frame without crashing", () => {
  const stream = new PassThrough();
  const received: unknown[] = [];
  new NativeMessageReader(stream, (msg) => received.push(msg));

  const badJson = Buffer.from("not json", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(badJson.length, 0);
  stream.write(header);
  stream.write(badJson);

  writeNativeMessage(stream, { ok: true });

  assert.deepEqual(received, [{ ok: true }]);
});

test("approval result parser accepts exactly one known result and fails closed otherwise", () => {
  assert.equal(parseApprovalResult("RESULT:ALLOW_ONCE\n"), "allow-once");
  assert.equal(parseApprovalResult("RESULT:ALLOW_ALWAYS\r\n"), "allow-always");
  assert.equal(parseApprovalResult("RESULT:DENY\n"), "deny");
  assert.equal(parseApprovalResult("RESULT:ALLOW_ONCE\nextra\n"), "deny");
  assert.equal(parseApprovalResult("RESULT:ALLOW_ONCE\n\n"), "deny");
  assert.equal(parseApprovalResult("unexpected\n"), "deny");
});
