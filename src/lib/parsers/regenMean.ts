import { naive } from "../time";
import type { Series, TenMinSample } from "../types";
import type { Row } from "./xlsx";

/**
 * Regen Powertech daily "mean" files: a few `#Regenpowertech` / `#MeanFile` /
 * `#Location` comment lines, then a `#time` header row and 144 ten-minute rows.
 *
 * Column positions shift from file to file (97–112 columns, occasionally
 * semicolon-delimited), so every file's own header is parsed. The register is
 * `data_energy_yield_e6 * 1e6 + data_energy_yield_1`; older exports carry only
 * the 6-digit `data_energy_yield_1`, which wraps at 1,000,000.
 */

const TIME_RE = /^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})$/;
export const REGEN_FILE_RE = /^(.+?)_m\d{6}\.(txt|xlsx)$/i;

function parseTime(token: string): number | null {
  const m = token.trim().match(TIME_RE);
  if (!m) return null;
  const [yy, mo, dd, hh, mi] = m.slice(1).map(Number);
  return naive(2000 + yy, mo, dd, hh, mi);
}

interface ParsedFile {
  samples: TenMinSample[];
  hasE6: boolean;
}

function fromRows(rows: string[][]): ParsedFile {
  const samples: TenMinSample[] = [];
  let idx: Map<string, number> | null = null;
  let headerLen = 0;
  for (const parts of rows) {
    if (!idx) {
      if (parts[0]?.startsWith("#time")) {
        idx = new Map(parts.map((c, i) => [c.trim(), i]));
        headerLen = parts.length;
      }
      continue;
    }
    const ts = parts[0] ? parseTime(parts[0]) : null;
    if (ts === null) continue;
    const ok = parts.length === headerLen;
    const get = (col: string): number | null => {
      const i = idx!.get(col);
      if (!ok || i === undefined || i >= parts.length) return null;
      const s = parts[i]?.trim();
      if (!s) return null;
      const v = Number(s);
      return Number.isFinite(v) ? v : null;
    };
    const y1 = get("data_energy_yield_1");
    const e6 = get("data_energy_yield_e6");
    samples.push({ ts, reg: y1 !== null && e6 !== null ? e6 * 1_000_000 + y1 : y1, pw: get("active_power_avg") });
  }
  return { samples, hasE6: idx?.has("data_energy_yield_e6") ?? false };
}

export function parseRegenText(text: string): ParsedFile {
  const lines = text.split(/\r?\n/);
  const hdr = lines.findIndex((ln) => ln.startsWith("#time"));
  if (hdr < 0) return { samples: [], hasE6: false };
  // data rows follow the header's delimiter (a few files use ';' instead of tab)
  const delim = lines[hdr].split("\t")[0].includes(";") ? ";" : "\t";
  return fromRows(lines.slice(hdr).map((ln) => ln.split(delim)));
}

export function parseRegenSheet(rows: Row[]): ParsedFile {
  return fromRows(rows.map((r) => r.map((c) => (c == null ? "" : String(c)))));
}

export function isRegenSheet(rows: Row[]): boolean {
  return rows.slice(0, 15).some((r) => typeof r[0] === "string" && (r[0].startsWith("#time") || r[0].startsWith("#Regenpowertech")));
}

/** Merge many daily files of one turbine into a single 10-min series. */
export function mergeRegenFiles(alias: string, sourceName: string, files: ParsedFile[]): Series {
  const merged = new Map<number, TenMinSample>();
  let anyE6 = false;
  for (const f of files) {
    anyE6 ||= f.hasE6;
    for (const s of f.samples) {
      const old = merged.get(s.ts);
      // prefer a row that carries the register over one that doesn't
      if (old && old.reg !== null && s.reg === null) continue;
      merged.set(s.ts, s);
    }
  }
  return {
    kind: "ten-min",
    key: `regen:${sourceName}:${alias}`,
    alias,
    format: "regen-mean",
    sourceName,
    registerModulo: anyE6 ? undefined : 1_000_000,
    samples: [...merged.values()].sort((a, b) => a.ts - b.ts),
  };
}
