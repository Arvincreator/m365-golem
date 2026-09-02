import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NATIVE_MSG_HOST_TO_EXT_MAX_BYTES } from "@m365-bridge/protocol";
import { sha256File, readFileInChunks, writeFileAtomic, ensureDir, getFileSize, fileExists } from "./index.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "files-test-"));
}

test("NATIVE_MSG_HOST_TO_EXT_MAX_BYTES is imported correctly from protocol", () => {
  assert.strictEqual(typeof NATIVE_MSG_HOST_TO_EXT_MAX_BYTES, "number");
  assert.ok(NATIVE_MSG_HOST_TO_EXT_MAX_BYTES > 0);
});

test("sha256File computes correct digest for known content", async () => {
  const dir = makeTmpDir();
  const filePath = path.join(dir, "hello.txt");
  fs.writeFileSync(filePath, "hello world");

  const digest = await sha256File(filePath);
  assert.strictEqual(
    digest,
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
  );
});

test("readFileInChunks splits a file larger than one chunk", async () => {
  const dir = makeTmpDir();
  const filePath = path.join(dir, "ten.bin");
  fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

  const chunks: { index: number; data: Buffer; last: boolean }[] = [];
  for await (const chunk of readFileInChunks(filePath, 3)) {
    chunks.push(chunk);
  }

  assert.strictEqual(chunks.length, 4);
  assert.strictEqual(chunks[0].data.length, 3);
  assert.strictEqual(chunks[1].data.length, 3);
  assert.strictEqual(chunks[2].data.length, 3);
  assert.strictEqual(chunks[3].data.length, 1);
  assert.strictEqual(chunks[0].index, 0);
  assert.strictEqual(chunks[3].index, 3);
  assert.strictEqual(chunks[0].last, false);
  assert.strictEqual(chunks[1].last, false);
  assert.strictEqual(chunks[2].last, false);
  assert.strictEqual(chunks[3].last, true);
});

test("readFileInChunks handles empty file", async () => {
  const dir = makeTmpDir();
  const filePath = path.join(dir, "empty.bin");
  fs.writeFileSync(filePath, Buffer.alloc(0));

  const chunks: { index: number; data: Buffer; last: boolean }[] = [];
  for await (const chunk of readFileInChunks(filePath, 3)) {
    chunks.push(chunk);
  }

  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].index, 0);
  assert.strictEqual(chunks[0].data.length, 0);
  assert.strictEqual(chunks[0].last, true);
});

test("writeFileAtomic leaves no .tmp- files behind after success", async () => {
  const dir = makeTmpDir();
  const filePath = path.join(dir, "atomic.txt");

  await writeFileAtomic(filePath, Buffer.from("atomic content"));

  const entries = fs.readdirSync(dir);
  const tmpFiles = entries.filter((e) => /\.tmp-/.test(e));
  assert.strictEqual(tmpFiles.length, 0);
  assert.strictEqual(fs.readFileSync(filePath, "utf8"), "atomic content");
});

test("ensureDir, getFileSize, fileExists behave as expected", async () => {
  const dir = makeTmpDir();
  const nestedDir = path.join(dir, "a", "b", "c");
  await ensureDir(nestedDir);
  assert.ok(fs.existsSync(nestedDir));

  const filePath = path.join(nestedDir, "f.txt");
  fs.writeFileSync(filePath, "1234567");

  assert.strictEqual(await getFileSize(filePath), 7);
  assert.strictEqual(await fileExists(filePath), true);
  assert.strictEqual(await fileExists(path.join(nestedDir, "missing.txt")), false);
});
