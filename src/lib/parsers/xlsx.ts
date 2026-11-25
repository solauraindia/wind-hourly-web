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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENTITIES[e.toLowerCase()] ?? m),
  );

/** Web portals often save an HTML table with an .xls name. One sheet per <table>; a <caption> becomes the first row. */
export function isHtmlTable(buf: Uint8Array) {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, 4096)).replace(/^﻿/, "").trimStart();
  return head.startsWith("<") && /<table/i.test(new TextDecoder("utf-8", { fatal: false }).decode(buf));
}

export function readHtmlTables(buf: Uint8Array): Sheet[] {
  const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const text = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).trim();
  return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((t, i) => {
    const rows: Row[] = [];
    const caption = t[0].match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    if (caption) rows.push([text(caption[1])]);
    for (const tr of t[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      rows.push([...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => text(c[1]) || null));
    }
    return { name: `Table ${i + 1}`, rows };
  });
}
