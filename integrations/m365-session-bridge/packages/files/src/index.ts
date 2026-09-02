import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export async function sha256File(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function ensureDir(absoluteDirPath: string): Promise<void> {
  await fs.promises.mkdir(absoluteDirPath, { recursive: true });
}

export async function writeFileAtomic(absolutePath: string, data: Buffer): Promise<void> {
  const dir = path.dirname(absolutePath);
  const suffix = crypto.randomBytes(8).toString("hex");
  const tmpPath = path.join(dir, `${path.basename(absolutePath)}.tmp-${suffix}`);
  try {
    await fs.promises.writeFile(tmpPath, data);
    await fs.promises.rename(tmpPath, absolutePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

export async function* readFileInChunks(
  absolutePath: string,
  chunkSizeBytes: number
): AsyncGenerator<{ index: number; data: Buffer; last: boolean }> {
  const size = await getFileSize(absolutePath);

  if (size === 0) {
    yield { index: 0, data: Buffer.alloc(0), last: true };
    return;
  }

  const fd = await fs.promises.open(absolutePath, "r");
  try {
    let position = 0;
    let index = 0;
    while (position < size) {
      const remaining = size - position;
      const readSize = Math.min(chunkSizeBytes, remaining);
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, position);
      position += readSize;
      const last = position >= size;
      yield { index, data: buffer, last };
      index += 1;
    }
  } finally {
    await fd.close();
  }
}

export async function getFileSize(absolutePath: string): Promise<number> {
  const stat = await fs.promises.stat(absolutePath);
  return stat.size;
}

export async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.promises.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
