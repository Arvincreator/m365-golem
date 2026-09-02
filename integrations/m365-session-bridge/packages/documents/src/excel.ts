import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { Workbook } from "exceljs";
import type { CreateExcelWorkbookInput } from "@m365-bridge/protocol";

export interface ExcelWorkbookResult {
  status: "success";
  outputPath: string;
  size: number;
}

type ExcelInput = z.infer<typeof CreateExcelWorkbookInput>;

function columnLetter(index: number): string {
  // 1-based column index -> spreadsheet letter (1 -> A, 26 -> Z, 27 -> AA, ...)
  let n = index;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export async function createExcelWorkbook(input: ExcelInput): Promise<ExcelWorkbookResult> {
  const workbook = new Workbook();

  for (const sheet of input.worksheets) {
    const worksheet = workbook.addWorksheet(sheet.name);

    if (sheet.columns) {
      worksheet.columns = sheet.columns.map((c) => ({
        header: c.header,
        key: c.key,
        width: c.width,
      }));
    }

    let rowCount = 0;
    let columnCount = sheet.columns?.length ?? 0;

    if (sheet.rowsByKey) {
      for (const rowObject of sheet.rowsByKey) {
        worksheet.addRow(rowObject);
        rowCount += 1;
      }
    } else if (sheet.rows) {
      for (const rowArray of sheet.rows) {
        worksheet.addRow(rowArray);
        rowCount += 1;
        columnCount = Math.max(columnCount, rowArray.length);
      }
    }

    if (sheet.freezeHeaderRow) {
      worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
    }

    if (sheet.autoFilter && rowCount > 0 && columnCount > 0) {
      const lastRow = sheet.columns ? rowCount + 1 : rowCount;
      const lastColumn = columnLetter(columnCount);
      worksheet.autoFilter = `A1:${lastColumn}${lastRow}`;
    }

    if (sheet.numberFormats) {
      for (const [key, format] of Object.entries(sheet.numberFormats)) {
        worksheet.getColumn(key).numFmt = format;
      }
    }
  }

  await fs.promises.mkdir(path.dirname(input.outputPath), { recursive: true });
  await workbook.xlsx.writeFile(input.outputPath);

  const stat = await fs.promises.stat(input.outputPath);
  return { status: "success", outputPath: input.outputPath, size: stat.size };
}
