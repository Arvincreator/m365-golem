import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWordDocument } from "./word.js";

test("createWordDocument writes a nonempty docx covering all block types", async () => {
  const outputPath = path.join(os.tmpdir(), `documents-test-${Date.now()}.docx`);

  const result = await createWordDocument({
    outputPath,
    header: "Header text",
    footer: "Footer text",
    blocks: [
      { type: "title", text: "Report Title" },
      { type: "heading", level: 1, text: "Section 1" },
      { type: "paragraph", runs: [{ text: "Hello ", bold: true }, { text: "world", italic: true }] },
      { type: "bulletList", items: ["one", "two"] },
      { type: "numberedList", items: ["first", "second"] },
      { type: "table", rows: [["A", "B"], ["1", "2"]], header: true },
      { type: "pageBreak" },
    ],
  });

  assert.strictEqual(result.status, "success");
  assert.strictEqual(result.outputPath, outputPath);
  assert.ok(fs.existsSync(outputPath), "output file should exist");
  const stat = fs.statSync(outputPath);
  assert.ok(stat.size > 0, "output file should be nonzero size");
  assert.strictEqual(result.size, stat.size);

  fs.unlinkSync(outputPath);
});

test("createWordDocument handles an empty blocks array without throwing", async () => {
  const outputPath = path.join(os.tmpdir(), `documents-test-empty-${Date.now()}.docx`);

  const result = await createWordDocument({ outputPath, blocks: [] });

  assert.strictEqual(result.status, "success");
  assert.ok(fs.existsSync(outputPath));
  assert.ok(fs.statSync(outputPath).size > 0);

  fs.unlinkSync(outputPath);
});
