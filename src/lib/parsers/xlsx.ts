import ExcelJS from "exceljs";

export type Cell = string | number | boolean | Date | null;
export type Row = Cell[];

/** Flatten exceljs cell values (rich text, formulas, hyperlinks) into plain values. */
export function plain(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return plain(o.result);
    if ("richText" in o && Array.isArray(o.richText)) return o.richText.map((t: { text: string }) => t.text).join("");
    if ("text" in o) return plain(o.text);
    if ("error" in o) return null;
  }
  return null;
}

export interface Sheet {
  name: string;
  /** 0-indexed rows of 0-indexed cells */
  rows: Row[];
}

export async function readWorkbook(buf: Uint8Array): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const rows: Row[] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const vals = row.values as unknown[];
      rows[rowNumber - 1] = Array.from(vals.slice(1), plain);
    });
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    return { name: ws.name, rows };
  });
}

export const str = (c: Cell | undefined) => (typeof c === "string" ? c.trim() : c == null ? "" : String(c).trim());
export const num = (c: Cell | undefined): number | null =>
  typeof c === "number" && Number.isFinite(c) ? c : typeof c === "string" && c.trim() !== "" && Number.isFinite(Number(c)) ? Number(c) : null;
