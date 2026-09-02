import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import type { CreateWordDocumentInput } from "@m365-bridge/protocol";

export interface WordDocumentResult {
  status: "success";
  outputPath: string;
  size: number;
}

const NUMBERED_LIST_REFERENCE = "documents-numbered-list";

type WordInput = z.infer<typeof CreateWordDocumentInput>;

type WordBlock =
  | { type: "title"; text: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; runs: { text: string; bold?: boolean; italic?: boolean }[] }
  | { type: "bulletList"; items: string[] }
  | { type: "numberedList"; items: string[] }
  | { type: "table"; rows: string[][]; header: boolean }
  | { type: "pageBreak" };

function headingLevelFor(level: 1 | 2 | 3): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    default:
      return HeadingLevel.HEADING_1;
  }
}

function buildBlockChildren(block: WordBlock): (Paragraph | Table)[] {
  switch (block.type) {
    case "title":
      return [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(block.text)] })];

    case "heading":
      return [
        new Paragraph({
          heading: headingLevelFor(block.level),
          children: [new TextRun(block.text)],
        }),
      ];

    case "paragraph":
      return [
        new Paragraph({
          children: block.runs.map(
            (run) =>
              new TextRun({
                text: run.text,
                bold: run.bold,
                italics: run.italic,
              })
          ),
        }),
      ];

    case "bulletList":
      return block.items.map(
        (item) =>
          new Paragraph({
            text: item,
            bullet: { level: 0 },
          })
      );

    case "numberedList":
      return block.items.map(
        (item) =>
          new Paragraph({
            text: item,
            numbering: { reference: NUMBERED_LIST_REFERENCE, level: 0 },
          })
      );

    case "table": {
      const rows = block.rows.map((row, rowIndex) => {
        const isHeaderRow = block.header && rowIndex === 0;
        return new TableRow({
          children: row.map(
            (cellText) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: cellText, bold: isHeaderRow })],
                  }),
                ],
              })
          ),
        });
      });
      return [new Table({ rows })];
    }

    case "pageBreak":
      return [new Paragraph({ children: [new PageBreak()] })];
  }
}

export async function createWordDocument(input: WordInput): Promise<WordDocumentResult> {
  const blocks = input.blocks as unknown as WordBlock[];
  const children = blocks.flatMap(buildBlockChildren);

  const headers = input.header
    ? {
        default: new Header({
          children: [new Paragraph({ text: input.header, alignment: AlignmentType.LEFT })],
        }),
      }
    : undefined;

  const footers = input.footer
    ? {
        default: new Footer({
          children: [new Paragraph({ text: input.footer, alignment: AlignmentType.LEFT })],
        }),
      }
    : undefined;

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: NUMBERED_LIST_REFERENCE,
          levels: [
            {
              level: 0,
              format: "decimal",
              text: "%1.",
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        headers,
        footers,
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);

  await fs.promises.mkdir(path.dirname(input.outputPath), { recursive: true });
  await fs.promises.writeFile(input.outputPath, buffer);

  return { status: "success", outputPath: input.outputPath, size: buffer.length };
}
