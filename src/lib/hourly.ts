import { HOUR, MINUTE, floorHour } from "./time";
import type { Series, TenMinSample } from "./types";

/**
 * A single machine in this fleet peaks near 1.5–2.7 MW, so 3000 kWh in one hour
 * is above any real output yet far below register glitch magnitudes (13k–17.6M).
 */
export const MAX_HOURLY_KWH = 3000;

export interface HourlyBuild {
  /** hour start → kWh */
  hours: Map<number, number>;
  /** hours filled from the active-power average instead of the register */
  estimated: Set<number>;
  /** hours inside the source window that produced no value, with the reason */
  dropped: Map<number, string>;
  /** 10-min timestamps present in the source (for gap reporting) */
  sampleTimes: number[];
}

function powerByHour(samples: TenMinSample[]): Map<number, number[]> {
  const by = new Map<number, number[]>();
  for (const s of samples) {
    if (s.pw === null) continue;
    const h = floorHour(s.ts);
    const arr = by.get(h);
    if (arr) arr.push(s.pw);
    else by.set(h, [s.pw]);
  }
  return by;
}

/**
 * Register method: kWh(H) = register(H+1:00) − register(H:00), accepted only in
 * [0, MAX_HOURLY_KWH]. Correct even when intermediate samples are missing,
 * because only the two boundary samples matter. Hours without a valid delta
 * fall back to the mean of the hour's six 10-min power samples (all six
 * required) and are flagged as estimated. Nothing is imputed beyond that.
 */
export function hourlyFromRegister(samples: TenMinSample[], registerModulo?: number): HourlyBuild {
  const out: HourlyBuild = { hours: new Map(), estimated: new Set(), dropped: new Map(), sampleTimes: samples.map((s) => s.ts) };
  if (!samples.length) return out;
  const reg = new Map<number, number>();
  for (const s of samples) if (s.reg !== null) reg.set(s.ts, s.reg);
  const pw = powerByHour(samples);

  const last = samples[samples.length - 1].ts;
  for (let h = floorHour(samples[0].ts); h + HOUR <= last + 10 * MINUTE; h += HOUR) {
    const a = reg.get(h);
    const b = reg.get(h + HOUR);
    let val: number | null = null;
    let reason = "register sample missing at hour boundary";
    if (a !== undefined && b !== undefined) {
      let delta = b - a;
      // bare 6-digit counters wrap from 999,999 back to 0
      if (registerModulo && delta < -registerModulo / 2) delta += registerModulo;
      if (delta >= 0 && delta <= MAX_HOURLY_KWH) val = delta;
      else reason = `register glitch/discontinuity (delta ${Math.round(delta).toLocaleString("en-US")} kWh)`;
    }
    if (val === null) {
      const p = pw.get(h);
      if (p && p.length === 6) {
        const est = p.reduce((x, y) => x + y, 0) / 6;
        if (est <= MAX_HOURLY_KWH) {
          val = est;
          out.estimated.add(h);
        }
      }
    }
    if (val !== null) out.hours.set(h, val);
    else out.dropped.set(h, reason);
  }
  return out;
}

/**
 * Power-only method: hourly kWh = mean of six 10-min average-kW samples.
 * Negative standby draw is kept, so idle hours can be slightly negative.
 */
export function hourlyFromPower(samples: TenMinSample[]): HourlyBuild {
  const out: HourlyBuild = { hours: new Map(), estimated: new Set(), dropped: new Map(), sampleTimes: samples.map((s) => s.ts) };
  const by = powerByHour(samples);
  if (!by.size) return out;
  const keys = [...by.keys()];
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  for (let h = first; h <= last; h += HOUR) {
    const v = by.get(h) ?? [];
    if (v.length === 6) out.hours.set(h, v.reduce((x, y) => x + y, 0) / 6);
    else out.dropped.set(h, `only ${v.length}/6 power samples`);
  }
  return out;
}

export function buildHourly(series: Series): HourlyBuild {
  if (series.kind === "hourly") {
    const out: HourlyBuild = { hours: new Map(series.hours), estimated: new Set(), dropped: new Map(), sampleTimes: [] };
    for (const b of series.blankHours) out.dropped.set(b, "blank cell in source");
    return out;
  }
  return series.powerOnly ? hourlyFromPower(series.samples) : hourlyFromRegister(series.samples, series.registerModulo);
}

/** Collapse missing 10-min slots between first and last sample into runs. */
export function tenMinGaps(times: number[]): { start: number; end: number; slots: number }[] {
  if (times.length < 2) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: { start: number; end: number; slots: number }[] = [];
  const step = 10 * MINUTE;
  for (let i = 1; i < sorted.length; i++) {
    const missing = Math.round((sorted[i] - sorted[i - 1]) / step) - 1;
    if (missing > 0) gaps.push({ start: sorted[i - 1] + step, end: sorted[i] - step, slots: missing });
  }
  return gaps;
}
