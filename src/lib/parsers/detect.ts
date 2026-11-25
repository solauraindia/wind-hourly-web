import { unzipSync } from "fflate";
import type { Series, SourceFormat } from "../types";
import { findDailyMatrixHeader, findHourlyLongHeader, parseDailyMatrix, parseHourlyLong } from "./hourlyTables";
import { parsePowerTrend, powerTrendFormat } from "./powerTrend";
import { REGEN_FILE_RE, isRegenSheet, mergeRegenFiles, parseRegenSheet, parseRegenText } from "./regenMean";
import { findScadaHeader, parseScada } from "./scadaMeterReading";
import { mergeSolarSeries, parseSolarWorkbook } from "./solar";
import { isHtmlTable, readHtmlTables, readWorkbook, type Row } from "./xlsx";

export interface InputFile {
  /** file name, possibly with a relative folder path ("RSMKP-01 MEAN file/RSMKP-01_m260401.txt") */
  name: string;
  data: Uint8Array;
}

export interface DetectWarning {
  file: string;
  message: string;
}

const basename = (p: string) => p.split("/").pop() ?? p;
const isJunk = (p: string) => p.includes("__MACOSX/") || basename(p).startsWith(".");

/** Unpack zips so every entry is treated like an individually uploaded file. */
function expand(files: InputFile[]): { file: InputFile; container: string }[] {
  const out: { file: InputFile; container: string }[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const entries = unzipSync(f.data);
      for (const [name, data] of Object.entries(entries)) {
        if (!name.endsWith("/") && !isJunk(name)) out.push({ file: { name, data }, container: basename(f.name).replace(/\.zip$/i, "") });
      }
    } else if (!isJunk(f.name)) {
      const dir = f.name.includes("/") ? f.name.split("/").slice(-2, -1)[0] : "";
      out.push({ file: f, container: dir });
    }
  }
  return out;
}

export function sniffSheet(rows: Row[]): SourceFormat | null {
  if (findScadaHeader(rows) >= 0) return "scada-meter-reading";
  const trend = powerTrendFormat(rows);
  if (trend) return trend;
  if (isRegenSheet(rows)) return "regen-mean";
  if (findDailyMatrixHeader(rows)) return "daily-matrix";
  if (findHourlyLongHeader(rows)) return "hourly-long";
  return null;
}

export async function detectAndParse(files: InputFile[]): Promise<{ series: Series[]; warnings: DetectWarning[] }> {
  const series: Series[] = [];
  const solar: Series[] = [];
  const warnings: DetectWarning[] = [];
  // regen daily files are grouped per turbine across the whole upload
  const regen = new Map<string, { source: string; files: ReturnType<typeof parseRegenText>[] }>();

  for (const { file, container } of expand(files)) {
    const name = basename(file.name);
    const regenMatch = name.match(REGEN_FILE_RE);
    try {
      if (/\.txt$/i.test(name) || /\.csv$/i.test(name)) {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(file.data);
        if (!text.includes("#time")) {
          warnings.push({ file: file.name, message: "Text file without a '#time' header — skipped" });
          continue;
        }
        const alias = regenMatch?.[1] ?? (container || name.replace(/\.\w+$/, ""));
        const g = regen.get(alias) ?? { source: container || name, files: [] };
        g.files.push(parseRegenText(text));
        regen.set(alias, g);
        continue;
      }
      if (/\.xls$/i.test(name)) {
        const tables = isHtmlTable(file.data) ? parseSolarWorkbook(readHtmlTables(file.data), name) : null;
        if (tables) solar.push(...tables);
        else warnings.push({ file: file.name, message: "Old-style .xls is not supported — save it as .xlsx" });
        continue;
      }
      if (!/\.xlsx$/i.test(name)) {
        warnings.push({ file: file.name, message: "Unsupported file type — skipped" });
        continue;
      }
      const sheets = await readWorkbook(file.data);
      // wind layouts first, so a solar sniff can never take over a known wind export
      if (!sheets.some((s) => sniffSheet(s.rows))) {
        const found = parseSolarWorkbook(sheets, name);
        if (found) {
          solar.push(...found);
          continue;
        }
      }
      let matched = false;
      for (const sheet of sheets) {
        const fmt = sniffSheet(sheet.rows);
        if (!fmt) continue;
        matched = true;
        if (fmt === "regen-mean") {
          const alias = regenMatch?.[1] ?? (container || name.replace(/\.xlsx$/i, ""));
          const g = regen.get(alias) ?? { source: container || name, files: [] };
          g.files.push(parseRegenSheet(sheet.rows));
          regen.set(alias, g);
        } else if (fmt === "scada-meter-reading") series.push(...parseScada(sheet.rows, name));
        else if (fmt === "power-trend" || fmt === "power-trend-hourly") series.push(...parsePowerTrend(sheet.rows, name));
        else if (fmt === "daily-matrix") series.push(...parseDailyMatrix(sheet.rows, name));
        else series.push(...parseHourlyLong(sheet.rows, name));
        break; // one data sheet per workbook
      }
      if (!matched) warnings.push({ file: file.name, message: "No recognised layout in any sheet — skipped" });
    } catch (e) {
      warnings.push({ file: file.name, message: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const [alias, g] of regen) {
    const s = mergeRegenFiles(alias, g.source, g.files);
    if (s.kind === "ten-min" && s.samples.length === 0) {
      warnings.push({ file: g.source, message: `${alias}: no readable 10-min rows` });
      continue;
    }
    series.push(s);
  }

  // solar plants arrive as one sheet or one file per month: join them per plant
  const merged = mergeSolarSeries(solar);
  series.push(...merged.series);
  for (const c of merged.conflicts) {
    warnings.push({ file: c.source, message: `${c.alias}: ${c.hours} hours appear more than once with different values — the first was kept` });
  }
  return { series, warnings };
}
