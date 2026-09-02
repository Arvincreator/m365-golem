import type { Readable, Writable } from "node:stream";

/**
 * Native Messaging wire format: a 4-byte native-endian (little-endian on
 * Windows) length prefix followed by that many bytes of UTF-8 JSON. No
 * newline delimiting, no text-mode translation.
 */
const LENGTH_PREFIX_BYTES = 4;

export function writeNativeMessage(output: Writable, obj: unknown): void {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32LE(json.length, 0);
  output.write(header);
  output.write(json);
}

export class NativeMessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(input: Readable, private onMessage: (msg: unknown) => void) {
    input.on("data", (chunk: Buffer) => this.feed(chunk));
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) return;
      const len = this.buffer.readUInt32LE(0);
      if (this.buffer.length < LENGTH_PREFIX_BYTES + len) return;
      const jsonBuf = this.buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + len);
      this.buffer = this.buffer.subarray(LENGTH_PREFIX_BYTES + len);
      try {
        this.onMessage(JSON.parse(jsonBuf.toString("utf8")));
      } catch {
        // Malformed frame — drop silently. Never log the raw bytes: they may
        // contain file content or other payload we must not persist.
      }
    }
  }
}
