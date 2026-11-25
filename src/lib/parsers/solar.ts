import { DAY, HOUR, MINUTE, floorHour, fromExcelDate } from "../time";
import type { Series, SourceFormat } from "../types";
import { parseDateTime } from "./hourlyTables";
import { num, str, type Row, type Sheet } from "./xlsx";

/**
 * Solar plant exports. Each plant's monitoring system has its own layout, but
 * they share two facts the parsers lean on:
 *
 * - Nothing is produced at night. Tamil Nadu sunrise is never before 05:45 and
 *   sunset never after 18:50 IST, so hours starting before 05:00 or from 19:00
 *   are zero. Counters reset overnight, so night readings are not trusted.
 * - Grids list the producing hours only. Any hour of a covered day that a grid
 *   does not list is zero.
 *
 * Layouts:
 * - solar-hour-grid (ALC): day × hour grid in either orientation; an hour label
 *   marks the hour START (06:00 = 06:00–07:00, checked against solar noon).
 *   '-' or blank = missing.
 * - solar-reading-grid (Acsen, `Time/Date` corner): hour × day grid of
 *   hour-ENDING readings. A blank means the reading was not taken and the next
 *   reading holds everything since the last one (daily totals confirm it).
 * - solar-day-blocks (Sambandam, `DATE:` blocks): one block per day, hour-ENDING
 *   inverter readings with the same roll-forward; plant groups side by side.
 * - solar-counter (Jayajothi, Jayavilas): an energy counter (daily or export),
 *   sampled hourly to every minute; hour = counter(H+1) − counter(H). Sheets
 *   named INV… are inverters of one plant and are summed.
 * - solar-interval (KM Knitwear, Jayavishnu): energy per 15-min interval, the
 *   stamp marking the interval END; hour = sum of its four intervals.
 *
 * A reading that covers several hours is spread over them in proportion to the
 * plant's typical output at those hours and flagged as estimated.
 */

export const DAYLIGHT_FROM = 5;
export const DAYLIGHT_TO = 19;

const hourOfDay = (ts: number) => new Date(ts).getUTCHours();
export const isNight = (ts: number) => hourOfDay(ts) < DAYLIGHT_FROM || hourOfDay(ts) >= DAYLIGHT_TO;
const dayOf = (ts: number) => ts - (((ts % DAY) + DAY) % DAY);

/** Headroom over the rating before an hour counts as a counter glitch. */
const RATING_HEADROOM = 1.25;
/** Plausible maximum when the rating is unknown: twice the largest plant. */
const DEFAULT_MAX_KWH = 20_000;

/** "6MW-APRIL", "3MW SOLAR HOURLY …", "Jayavilas_8 MW.xlsx" → "6MW". */
export function capacityLabel(...texts: string[]): string | null {
  for (const t of texts) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*MW/i);
    if (m) return `${Number(m[1])}MW`;
  }
  return null;
}

const maxKwhFor = (label: string | null) => (label ? parseFloat(label) * 1000 * RATING_HEADROOM : DEFAULT_MAX_KWH);

/** Hour of day of a time-only cell ("06:00", 0.25, or exceljs' 1899-12-30T06:00Z); whole hours only. */
export function hourLabel(c: Row[number] | undefined): number | null {
  let h: number | null = null;
  let mi = 0;
  if (c instanceof Date && c.getUTCFullYear() <= 1900) {
    h = c.getUTCHours();
    mi = c.getUTCMinutes();
  } else if (typeof c === "number" && c >= 0 && c <= 1) {
    const m = Math.round(c * 24 * 60);
    h = Math.floor(m / 60);
    mi = m % 60;
  } else if (typeof c === "string") {
    const m = c.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (m) {
      h = +m[1];
      mi = +m[2];
    }
  }
  return h !== null && mi === 0 && h <= 24 ? h : null;
}

/** A calendar day cell (a real date, not a time of day). */
function dayCell(c: Row[number] | undefined): number | null {
  if (c instanceof Date && c.getUTCFullYear() <= 1900) return null;
  const ts = fromExcelDate(c) ?? (typeof c === "string" ? parseDateTime(c) : null);
  return ts !== null && ts === dayOf(ts) ? ts : null;
}

/* Hour collection ------------------------------------------------------------- */

class Hours {
  readonly hours = new Map<number, number>();
  readonly blank = new Set<number>();
  readonly estimated = new Set<number>();
  readonly dropped = new Map<number, string>();
  readonly days = new Set<number>();

  set(ts: number, v: number, estimated = false) {
    if (this.hours.has(ts)) return; // first source wins
    this.hours.set(ts, v);
    this.blank.delete(ts);
    this.dropped.delete(ts);
    if (estimated) this.estimated.add(ts);
    this.days.add(dayOf(ts));
  }

  missing(ts: number, reason?: string) {
    this.days.add(dayOf(ts));
    if (this.hours.has(ts)) return;
    if (reason) this.dropped.set(ts, reason);
    else this.blank.add(ts);
  }

  cover(day: number) {
    this.days.add(day);
  }

  /**
   * `unlisted`: what an hour of a covered day the source never mentions is —
   * "zero" for grids (they list every producing hour), "night" when only night
   * hours are known to be zero and daylight hours are missing.
   */
  toSeries(format: SourceFormat, alias: string, sourceName: string, unlisted: "zero" | "night"): Series {
    for (const d of this.days) {
      for (let h = 0; h < 24; h++) {
        const ts = d + h * HOUR;
        if (this.hours.has(ts) || this.blank.has(ts) || this.dropped.has(ts)) continue;
        if (unlisted === "zero" || isNight(ts)) this.hours.set(ts, 0);
      }
    }
    return {
      kind: "hourly",
      key: `${format}:${sourceName}:${alias}`,
      alias,
      format,
      sourceName,
      hours: [...this.hours.entries()].sort((a, b) => a[0] - b[0]),
      blankHours: [...this.blank].sort((a, b) => a - b),
      estimatedHours: [...this.estimated].sort((a, b) => a - b),
      dropped: [...this.dropped.entries()].sort((a, b) => a[0] - b[0]),
    };
  }
}

/* Hour-ending readings with roll-forward ---------------------------------------- */

/** One reading: `kwh` produced over the hours starting at each of `hours`. */
interface Span {
  hours: number[];
  kwh: number;
}

/**
 * Turn one day's hour-ending readings into spans. A reading covers every hour
 * since the previous reading (the first label covers just its own hour). Hours
 * after the last reading produced nothing; a day without any reading is missing.
 */
function rollForward(day: number, readings: [number, number | null][], out: Hours, spans: Span[]) {
  if (!readings.length) return;
  out.cover(day);
  if (readings.every(([, v]) => v === null)) {
    for (let h = readings[0][0] - 1; h < readings[readings.length - 1][0]; h++) out.missing(day + h * HOUR);
    return;
  }
  let from = readings[0][0] - 1;
  for (const [label, v] of readings) {
    if (v === null) continue;
    const hours: number[] = [];
    for (let h = Math.max(from, 0); h < label; h++) hours.push(day + h * HOUR);
    if (hours.length) spans.push({ hours, kwh: v });
    from = label;
  }
}

/** Spread multi-hour spans by the plant's mean output per hour of day (from single-hour readings). */
function spreadSpans(spans: Span[], out: Hours) {
  const by = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  for (const s of spans) {
    if (s.hours.length !== 1) continue;
    by[hourOfDay(s.hours[0])].sum += Math.max(s.kwh, 0);
    by[hourOfDay(s.hours[0])].n += 1;
  }
  const typical = (ts: number) => {
    const b = by[hourOfDay(ts)];
    return b.n ? b.sum / b.n : 0;
  };
  for (const s of spans) {
    if (s.hours.length === 1) {
      out.set(s.hours[0], s.kwh);
      continue;
    }
    const w = s.hours.map(typical);
    const total = w.reduce((a, b) => a + b, 0);
    s.hours.forEach((ts, i) => out.set(ts, (s.kwh * (total > 0 ? w[i] / total : 1 / s.hours.length)), true));
  }
}

/* solar-hour-grid ------------------------------------------------------------- */

const MIN_LABELS = 6;

/** Row with a corner cell and ≥ MIN_LABELS hour labels after it (days down the side). */
function findHourHeader(rows: Row[]) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cols = rows[i].flatMap((c, j) => (hourLabel(c) !== null ? [j] : []));
    if (cols.length >= MIN_LABELS && /^date$/i.test(str(rows[i][cols[0] - 1]))) return { row: i, dateCol: cols[0] - 1, cols };
  }
  return null;
}

/** Row with ≥ 5 day cells whose next row starts with an hour label (hours down the side). */
function findDayHeader(rows: Row[]) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cols = rows[i].flatMap((c, j) => (dayCell(c) !== null ? [j] : []));
    if (cols.length < 5) continue;
    const labelCol = cols[0] - 1;
    if (labelCol >= 0 && hourLabel(rows[i + 1]?.[labelCol]) !== null) return { row: i, labelCol, cols };
  }
  return null;
}

const isReadingGrid = (rows: Row[]) => rows.slice(0, 10).some((r) => r.some((c) => /^time\s*\/\s*date$/i.test(str(c))));

export function isSolarHourGrid(rows: Row[]) {
  return !isReadingGrid(rows) && (findHourHeader(rows) !== null || findDayHeader(rows) !== null);
}

export function parseSolarHourGrid(sheet: Sheet, sourceName: string): Series[] {
  const { rows } = sheet;
  const title = rows.slice(0, 3).flat().map(str).join(" ");
  const alias = capacityLabel(sheet.name, title, sourceName) ?? "SOLAR";
  const out = new Hours();
  const put = (day: number, h: number, c: Row[number] | undefined) => {
    const v = num(c);
    if (v === null) out.missing(day + h * HOUR);
    else out.set(day + h * HOUR, v);
  };
  const byRow = findHourHeader(rows);
  if (byRow) {
    for (let r = byRow.row + 1; r < rows.length; r++) {
      const day = dayCell(rows[r][byRow.dateCol]);
      if (day === null) continue;
      out.cover(day);
      for (const c of byRow.cols) put(day, hourLabel(rows[byRow.row][c])!, rows[r][c]);
    }
  } else {
    const byCol = findDayHeader(rows);
    if (!byCol) throw new Error(`${sourceName} / ${sheet.name}: no date × hour grid`);
    for (let r = byCol.row + 1; r < rows.length; r++) {
      const h = hourLabel(rows[r][byCol.labelCol]);
      if (h === null) continue;
      for (const c of byCol.cols) {
        const day = dayCell(rows[byCol.row][c])!;
        out.cover(day);
        put(day, h, rows[r][c]);
      }
    }
  }
  return [out.toSeries("solar-hour-grid", alias, sourceName, "zero")];
}

/* solar-reading-grid ---------------------------------------------------------- */

export function isSolarReadingGrid(rows: Row[]) {
  return isReadingGrid(rows);
}

export function parseSolarReadingGrid(sheet: Sheet, sourceName: string): Series[] {
  const { rows } = sheet;
  const h = rows.findIndex((r, i) => i < 10 && r.some((c) => /^time\s*\/\s*date$/i.test(str(c))));
  const corner = rows[h].findIndex((c) => /^time\s*\/\s*date$/i.test(str(c)));
  const title = rows.slice(0, h).flat().map(str).join(" ");
  const alias = capacityLabel(title, sourceName) ?? "SOLAR";
  const dayCols = rows[h].flatMap((c, j) => (j > corner && dayCell(c) !== null ? [j] : []));
  const labelRows: { r: number; label: number }[] = [];
  for (let r = h + 1; r < rows.length; r++) {
    const label = hourLabel(rows[r][corner]);
    if (label !== null) labelRows.push({ r, label });
  }
  const out = new Hours();
  const spans: Span[] = [];
  for (const c of dayCols) {
    const day = dayCell(rows[h][c])!;
    rollForward(day, labelRows.map(({ r, label }) => [label, num(rows[r][c])]), out, spans);
  }
  spreadSpans(spans, out);
  return [out.toSeries("solar-reading-grid", alias, sourceName, "zero")];
}

/* solar-day-blocks ------------------------------------------------------------ */

const isBlockStart = (r: Row) => /^date\s*:?$/i.test(str(r[0])) && r.some((c) => /^time$/i.test(str(c)));

export function isSolarDayBlocks(rows: Row[]) {
  return rows.slice(0, 10).some(isBlockStart);
}

export function parseSolarDayBlocks(sheet: Sheet, sourceName: string): Series[] {
  const { rows } = sheet;
  const plants = new Map<string, { out: Hours; spans: Span[] }>();
  for (let i = 0; i < rows.length; i++) {
    if (!isBlockStart(rows[i])) continue;
    const head = rows[i];
    const sub = rows[i + 1] ?? [];
    const day = dayCell(head[1]);
    const timeCol = head.findIndex((c) => /^time$/i.test(str(c)));
    if (day === null) continue;
    // energy columns: sub-header "… GEN"; plant = nearest group label on the DATE row at or left of it
    const groups = new Map<string, number[]>();
    for (let c = timeCol + 1; c < Math.max(head.length, sub.length); c++) {
      if (!/gen/i.test(str(sub[c]))) continue;
      let g = c;
      while (g > timeCol && !str(head[g])) g--;
      const name = str(head[g]);
      if (g > timeCol && name) groups.set(name, [...(groups.get(name) ?? []), c]);
    }
    const readings = new Map<string, [number, number | null][]>([...groups.keys()].map((g) => [g, []]));
    let r = i + 2;
    for (; r < rows.length && !isBlockStart(rows[r]); r++) {
      const label = hourLabel(rows[r][timeCol]);
      if (label === null) continue;
      for (const [g, cols] of groups) {
        const vals = cols.map((c) => num(rows[r][c]));
        readings.get(g)!.push([label, vals.some((v) => v === null) ? null : vals.reduce<number>((a, b) => a + (b as number), 0)]);
      }
    }
    for (const [g, list] of readings) {
      const p = plants.get(g) ?? { out: new Hours(), spans: [] };
      plants.set(g, p);
      rollForward(day, list, p.out, p.spans);
    }
    i = r - 1;
  }
  return [...plants.entries()].map(([alias, p]) => {
    spreadSpans(p.spans, p.out);
    return p.out.toSeries("solar-day-blocks", alias, sourceName, "zero");
  });
}

/* solar-counter / solar-interval ---------------------------------------------- */

const ENERGY_RE = /daily_?kwh|today\s*(generation|energy)|export\s*\(kwh\)/i;
const STAMP_RE = /^timestamp$|date\s*&\s*time|^time\s*\(hh:mm\)$/i;

/** Header of a time series with an energy column: [stamp column | date + time columns, energy column]. */
function findSeriesHeader(rows: Row[]) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i].map(str);
    const energy = r.findIndex((c) => ENERGY_RE.test(c));
    if (energy < 0) continue;
    // Jayavilas' second counter (IGOC, about 1% below the inverter's) is labelled on the row below
    const backup = [r, (rows[i + 1] ?? []).map(str)].map((x) => x.findIndex((c) => /^igoc$/i.test(c))).find((c) => c >= 0) ?? -1;
    const stamp = r.findIndex((c) => STAMP_RE.test(c));
    if (stamp >= 0) return { row: i, stamp, time: -1, energy, backup };
    const date = r.findIndex((c) => /^date$/i.test(c));
    const time = r.findIndex((c) => /^time$/i.test(c));
    if (date >= 0 && time >= 0) return { row: i, stamp: date, time, energy, backup };
  }
  return null;
}

export function isSolarSeries(rows: Row[]) {
  return findSeriesHeader(rows) !== null;
}

type Sample = [number, number];

/** The same day with month and day swapped (2026-05-01 → 2026-01-05), or null when that is no date. */
function swapped(day: number): number | null {
  const d = new Date(day);
  const [m, dd] = [d.getUTCMonth() + 1, d.getUTCDate()];
  if (dd > 12 || dd === m) return null;
  const s = Date.UTC(d.getUTCFullYear(), dd - 1, m);
  return new Date(s).getUTCDate() === m ? s : null;
}

/**
 * Exports that passed through a dd/mm ↔ mm/dd mix-up store days 1–12 with
 * month and day swapped, which shows as rows going back and forth in time
 * (Jayajothi: 04-01, 05-01 … 12-01, 04-02 …, really 4 Jan, 5 Jan …). Rows are
 * logged in time order, so read each day either way, walking forward, and keep
 * the reading of the sheet that steps forward most steadily: backward steps
 * and jumps of more than a day both count against it. Untouched when the as-is
 * order is already steady.
 */
export function fixDayMonthSwaps(days: number[]): number[] {
  const walk = (startSwapped: boolean) => {
    const out: number[] = [];
    let prev: number | null = null;
    let cost = 0;
    for (const d of days) {
      const options = [d, swapped(d)].filter((x): x is number => x !== null);
      let pick: number;
      if (prev === null) pick = startSwapped ? (swapped(d) ?? d) : d;
      else {
        const forward = options.filter((x) => x >= prev!);
        pick = forward.length ? Math.min(...forward) : d;
      }
      if (prev !== null && pick !== prev) cost += pick < prev || pick - prev > DAY ? 1 : 0;
      out.push(pick);
      prev = pick;
    }
    return { out, cost };
  };
  const asIs = days.reduce((c, d, i) => c + (i && d !== days[i - 1] && (d < days[i - 1] || d - days[i - 1] > DAY) ? 1 : 0), 0);
  if (asIs === 0) return days;
  const best = [walk(false), walk(true)].sort((a, b) => a.cost - b.cost)[0];
  return best.cost < asIs ? best.out : days;
}

function seriesSamples(rows: Row[], column: "energy" | "backup" = "energy"): Sample[] {
  const h = findSeriesHeader(rows)!;
  const col = h[column];
  if (col < 0) return [];
  const raw: { day: number; time: number; v: number }[] = [];
  for (let r = h.row + 1; r < rows.length; r++) {
    let ts = parseDateTime(rows[r][h.stamp]);
    if (ts === null) continue;
    if (h.time >= 0) {
      const t = hourLabel(rows[r][h.time]);
      if (t === null) continue;
      ts = dayOf(ts) + t * HOUR;
    }
    const v = num(rows[r][col]);
    ts = Math.round(ts / MINUTE) * MINUTE;
    if (v !== null) raw.push({ day: dayOf(ts), time: ts - dayOf(ts), v });
  }
  const days = fixDayMonthSwaps(raw.map((x) => x.day));
  // a stamp logged twice keeps its first reading
  const seen = new Map<number, number>();
  raw.forEach((x, i) => {
    const ts = days[i] + x.time;
    if (!seen.has(ts)) seen.set(ts, x.v);
  });
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Interval energy falls about as much as it rises (up in the morning, down in
 * the afternoon); a counter only rises, apart from its daily reset. Compared
 * over daylight steps, leaving out each day's largest fall (the reset).
 */
export function looksCumulative(samples: Sample[]) {
  let rise = 0;
  let fall = 0;
  const biggest = new Map<number, number>();
  for (let i = 1; i < samples.length; i++) {
    const [t, v] = samples[i];
    const [pt, pv] = samples[i - 1];
    if (isNight(t) || dayOf(t) !== dayOf(pt)) continue;
    if (v >= pv) rise += v - pv;
    else {
      fall += pv - v;
      biggest.set(dayOf(t), Math.max(biggest.get(dayOf(t)) ?? 0, pv - v));
    }
  }
  for (const b of biggest.values()) fall -= b;
  return rise > 0 && fall < 0.2 * rise;
}

/** Days with at least one reading inside daylight (a file's trailing midnight stamp does not add a day). */
const daylightDays = (samples: Sample[], step: number) => new Set(samples.filter(([t]) => !isNight(t - step)).map(([t]) => dayOf(t - step)));

/** Counter value at `t`: the median of samples within ±5 minutes (shrugs off single-sample spikes). */
function counterAt(samples: Sample[], t: number): number | null {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] < t - 5 * MINUTE) lo = mid + 1;
    else hi = mid;
  }
  const near: number[] = [];
  for (let i = lo; i < samples.length && samples[i][0] <= t + 5 * MINUTE; i++) near.push(samples[i][1]);
  if (!near.length) return null;
  near.sort((a, b) => a - b);
  return near[Math.floor((near.length - 1) / 2)];
}

/** Hourly kWh from a counter: daylight hours only; a fall is a reset, so the hour is what counted since. */
export function hoursFromCounter(samples: Sample[], maxKwh: number): Hours {
  const out = new Hours();
  for (const day of daylightDays(samples, 0)) {
    out.cover(day);
    let glitch = false;
    for (let h = DAYLIGHT_FROM; h < DAYLIGHT_TO; h++) {
      const ts = day + h * HOUR;
      const a = counterAt(samples, ts);
      const b = counterAt(samples, ts + HOUR);
      if (a === null || b === null) {
        out.missing(ts, "counter reading missing at hour boundary");
        glitch = false;
        continue;
      }
      // a fall is the daily reset, unless the counter is only coming back from a glitch
      const delta: number = b >= a ? b - a : glitch ? NaN : b;
      glitch = !(delta >= 0 && delta <= maxKwh);
      if (glitch) out.missing(ts, `counter glitch (${Number.isNaN(delta) ? "back from a jump" : `${Math.round(delta).toLocaleString("en-US")} kWh`})`);
      else out.set(ts, delta);
    }
  }
  return out;
}

/** Hourly kWh from interval energy stamped at the interval END; daylight hours need every interval. */
export function hoursFromIntervals(samples: Sample[]): Hours {
  const out = new Hours();
  const gaps = new Map<number, number>();
  for (let i = 1; i < samples.length; i++) {
    const g = samples[i][0] - samples[i - 1][0];
    if (g > 0) gaps.set(g, (gaps.get(g) ?? 0) + 1);
  }
  const step = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 15 * MINUTE;
  const per = Math.round(HOUR / step);
  const by = new Map<number, Map<number, number>>();
  for (const [t, v] of samples) {
    const h = floorHour(t - step);
    const m = by.get(h) ?? new Map<number, number>();
    if (!m.has(t)) m.set(t, v);
    by.set(h, m);
  }
  for (const day of daylightDays(samples, step)) {
    out.cover(day);
    for (let h = DAYLIGHT_FROM; h < DAYLIGHT_TO; h++) {
      const ts = day + h * HOUR;
      const vals = [...(by.get(ts)?.values() ?? [])];
      if (vals.length === per) out.set(ts, vals.reduce((a, b) => a + b, 0));
      else out.missing(ts, `only ${vals.length}/${per} interval readings`);
    }
  }
  return out;
}

/** A backup counter stands in for a day only if it shows at least this share of a normal day. */
const ALIVE_SHARE = 0.1;

/**
 * A counter that did not move all day is an empty or stuck column, not a day
 * without sun. Such days take the backup counter's hours (flagged estimated)
 * when it shows a believable day, and are missing otherwise.
 */
function patchDeadDays(main: Hours, backup: Hours | null) {
  const daylightHours = (day: number) => Array.from({ length: DAYLIGHT_TO - DAYLIGHT_FROM }, (_, k) => day + (DAYLIGHT_FROM + k) * HOUR);
  const total = (h: Hours, day: number) => daylightHours(day).reduce((a, ts) => a + Math.max(h.hours.get(ts) ?? 0, 0), 0);
  const normal = [...main.days].map((d) => total(main, d)).filter((v) => v > 0).sort((a, b) => a - b);
  const median = normal.length ? normal[Math.floor(normal.length / 2)] : 0;
  for (const day of new Set([...main.days, ...(backup?.days ?? [])])) {
    if (total(main, day) > 0) continue;
    const useBackup = !!backup && median > 0 && total(backup, day) >= ALIVE_SHARE * median;
    main.cover(day);
    for (const ts of daylightHours(day)) {
      main.hours.delete(ts);
      main.blank.delete(ts);
      main.dropped.delete(ts);
      const v = useBackup ? backup!.hours.get(ts) : undefined;
      if (v !== undefined) main.set(ts, v, true);
      else main.missing(ts, useBackup ? (backup!.dropped.get(ts) ?? "counter reading missing at hour boundary") : "counter did not move all day");
    }
  }
}

/**
 * All time-series sheets of one workbook. Sheets named INV… are inverters of
 * one plant (summed hour by hour); otherwise sheets are consecutive periods.
 */
export function parseSolarSeries(sheets: Sheet[], sourceName: string): Series[] {
  const used = sheets.filter((s) => isSolarSeries(s.rows));
  const inverters = used.length > 1 && used.every((s) => /\binv/i.test(s.name));
  const channels = inverters
    ? used.map((s) => ({ name: s.name, samples: seriesSamples(s.rows) }))
    : [{ name: "", samples: used.flatMap((s) => seriesSamples(s.rows)).sort((a, b) => a[0] - b[0]) }];
  const title = sheets.flatMap((s) => s.rows.slice(0, 2).flat().map(str)).join(" ");
  const alias =
    capacityLabel(sourceName, title) ??
    (inverters ? `${channels.reduce((s, c) => s + parseFloat(capacityLabel(c.name) ?? "0"), 0)}MW` : "SOLAR");
  const cumulative = looksCumulative(channels[0].samples);
  const format: SourceFormat = cumulative ? "solar-counter" : "solar-interval";
  const built = channels.map((c) => ({
    name: c.name,
    hours: cumulative ? hoursFromCounter(c.samples, maxKwhFor(capacityLabel(c.name) ?? alias)) : hoursFromIntervals(c.samples),
  }));
  if (cumulative) {
    const backup = built.length === 1 ? used.flatMap((s) => seriesSamples(s.rows, "backup")).sort((a, b) => a[0] - b[0]) : [];
    for (const b of built) patchDeadDays(b.hours, backup.length ? hoursFromCounter(backup, maxKwhFor(alias)) : null);
  }
  if (built.length === 1) return [built[0].hours.toSeries(format, alias, sourceName, "night")];

  const out = new Hours();
  const all = new Set(built.flatMap((b) => [...b.hours.hours.keys(), ...b.hours.dropped.keys(), ...b.hours.blank]));
  for (const ts of all) {
    let sum = 0;
    let reason: string | null = null;
    for (const b of built) {
      const v = b.hours.hours.get(ts);
      if (v === undefined) {
        reason = `${b.name}: ${b.hours.dropped.get(ts) ?? "no reading"}`;
        break;
      }
      sum += v;
    }
    if (reason) out.missing(ts, reason);
    else out.set(ts, sum);
  }
  return [out.toSeries(format, alias, sourceName, "night")];
}

/* Workbook entry point -------------------------------------------------------- */

/** Solar series in a workbook, or null when no sheet has a solar layout. */
export function parseSolarWorkbook(sheets: Sheet[], sourceName: string): Series[] | null {
  if (sheets.some((s) => isSolarSeries(s.rows))) return parseSolarSeries(sheets, sourceName);
  const series: Series[] = [];
  for (const sheet of sheets) {
    if (isSolarDayBlocks(sheet.rows)) series.push(...parseSolarDayBlocks(sheet, sourceName));
    else if (isSolarReadingGrid(sheet.rows)) series.push(...parseSolarReadingGrid(sheet, sourceName));
    else if (isSolarHourGrid(sheet.rows)) series.push(...parseSolarHourGrid(sheet, sourceName));
  }
  return series.length ? series : null;
}

/* Merging --------------------------------------------------------------------- */

/** "KM Knitwear_2MW-Daily Generation TEB-21-11-2026 (3).xls" → "KM Knitwear_2MW-Daily Generation TEB". */
export function sourceStem(name: string) {
  return name
    .replace(/\.\w+$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .replace(/[-_ ]*\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/, "")
    .trim();
}

/**
 * Join solar series of one plant split across sheets or files (one per month).
 * The first value for an hour wins; differing repeats are reported.
 */
export function mergeSolarSeries(series: Series[]): { series: Series[]; conflicts: { source: string; alias: string; hours: number }[] } {
  const groups = new Map<string, Series[]>();
  for (const s of series) {
    // a plant name read from the content ("SSML") identifies the plant; a capacity label needs the file name too
    const byContent = !/^(\d+(\.\d+)?MW|SOLAR)$/.test(s.alias);
    const k = `${s.format}|${s.alias}|${byContent ? "" : sourceStem(s.sourceName)}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const out: Series[] = [];
  const conflicts: { source: string; alias: string; hours: number }[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    const merged = new Hours();
    let clash = 0;
    for (const s of g) {
      if (s.kind !== "hourly") continue;
      const est = new Set(s.estimatedHours);
      for (const [ts, v] of s.hours) {
        const prev = merged.hours.get(ts);
        if (prev !== undefined && Math.abs(prev - v) > 0.05) clash++;
        merged.set(ts, v, est.has(ts));
      }
      for (const ts of s.blankHours) merged.missing(ts);
      for (const [ts, reason] of s.dropped ?? []) merged.missing(ts, reason);
    }
    const names = [...new Set(g.map((s) => s.sourceName))];
    const sourceName = names.length === 1 ? names[0] : names.length === 2 ? names.join(" + ") : `${sourceStem(names[0])} (${names.length} files)`;
    const first = g[0];
    if (clash) conflicts.push({ source: sourceName, alias: first.alias, hours: clash });
    out.push(merged.toSeries(first.format, first.alias, sourceName, "night"));
  }
  return { series: out, conflicts };
}
