import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Workbook } from "exceljs";
import { createExcelWorkbook } from "./excel.js";

test("createExcelWorkbook writes a valid, readable xlsx", async () => {
  const outputPath = path.join(os.tmpdir(), `documents-test-${Date.now()}.xlsx`);

  const result = await createExcelWorkbook({
    outputPath,
    worksheets: [
      {
        name: "Sheet1",
        columns: [
          { header: "Name", key: "name", width: 20 },
          { header: "Amount", key: "amount", width: 10 },
        ],
        rowsByKey: [
          { name: "Alice", amount: 100 },
          { name: "Bob", amount: 200 },
        ],
        freezeHeaderRow: true,
        autoFilter: true,
        numberFormats: { amount: "#,##0.00" },
      },
    ],
  });

  assert.strictEqual(result.status, "success");
  assert.strictEqual(result.outputPath, outputPath);
  assert.ok(fs.existsSync(outputPath), "output file should exist");
  assert.ok(fs.statSync(outputPath).size > 0, "output file should be nonzero size");
  assert.strictEqual(result.size, fs.statSync(outputPath).size);

  const readBack = new Workbook();
  await readBack.xlsx.readFile(outputPath);
  const worksheet = readBack.getWorksheet("Sheet1");
  assert.ok(worksheet, "worksheet should exist");
  assert.strictEqual(worksheet!.name, "Sheet1");

  // Header row + 2 data rows
  assert.strictEqual(worksheet!.rowCount, 3);
  assert.strictEqual(worksheet!.getRow(2).getCell(1).value, "Alice");
  assert.strictEqual(worksheet!.getRow(3).getCell(2).value, 200);

  fs.unlinkSync(outputPath);
});

test("createExcelWorkbook supports plain value-array rows", async () => {
  const outputPath = path.join(os.tmpdir(), `documents-test-rows-${Date.now()}.xlsx`);

  await createExcelWorkbook({
    outputPath,
    worksheets: [
      {
        name: "Plain",
        rows: [
          ["a", 1],
          ["b", 2],
        ],
        freezeHeaderRow: false,
        autoFilter: false,
      },
    ],
  });

  const readBack = new Workbook();
  await readBack.xlsx.readFile(outputPath);
  const worksheet = readBack.getWorksheet("Plain");
  assert.ok(worksheet);
  assert.strictEqual(worksheet!.rowCount, 2);
  assert.strictEqual(worksheet!.getRow(1).getCell(1).value, "a");
  assert.strictEqual(worksheet!.getRow(2).getCell(2).value, 2);

  fs.unlinkSync(outputPath);
});
