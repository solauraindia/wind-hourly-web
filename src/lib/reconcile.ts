/**
 * Reconciliation math: bring a month's hourly statement to a target near the
 * issued (metered) volume. A month short of the target is raised in two steps:
 *
 * 1. Fill hours the logger missed, from evidence: sibling turbines at the same
 *    site, or this turbine's own readings around the gap. Calm hours (no wind)
 *    and hours without evidence stay empty.
 * 2. Scale: one factor on every producing hour, never above the rating.
 *
 * A month above the target is only scaled down (one factor below 1); gaps stay empty.
 *
 * Values keep the month's own precision (whole kWh or 0.1 kWh, see roundKwh).
 *
 * Pure functions on one month's hours (index = hour of the month, so
 * index % 24 is the hour of day). No randomness: same input, same output.
 */

import { decimalsOf, roundTo } from "./compute";

export interface Rule {
  /** each month's target is picked between issued +marginPct and +marginMaxPct */
  marginPct: number;
  marginMaxPct: number;
  bandMinPct: number;
  bandMaxPct: number;
}

export const DEFAULT_RULE: Rule = { marginPct: 4, marginMaxPct: 5, bandMinPct: -5, bandMaxPct: 5 };

/** Rule values (target and band) must stay within ±this % of issued. */
export const RULE_LIMIT_PCT = 5;

/** "Calm" = below this share of the rating. */
export const CALM_SHARE = 0.02;

export function validateRule(input: unknown): Rule | string {
  if (!input || typeof input !== "object") return "Missing reconcile rule";
  const r = input as Record<string, unknown>;
  const [m, mx, lo, hi] = [r.marginPct, r.marginMaxPct, r.bandMinPct, r.bandMaxPct];
  if (![m, mx, lo, hi].every((v) => typeof v === "number" && Number.isFinite(v))) return "Rule values must be numbers";
  const rule = { marginPct: m as number, marginMaxPct: mx as number, bandMinPct: lo as number, bandMaxPct: hi as number };
  if (rule.bandMinPct < -RULE_LIMIT_PCT || rule.bandMaxPct > RULE_LIMIT_PCT) return `Rule values must be within ±${RULE_LIMIT_PCT}% of issued`;
  if (rule.marginPct > rule.marginMaxPct) return "The target range is reversed";
  if (!(rule.bandMinPct <= rule.marginPct && rule.marginMaxPct <= rule.bandMaxPct)) return "The band must contain the target range";
  return rule;
}

/**
 * The month's target, % above issued: a spread-out pick inside the rule's target
 * range, seeded by device and month so a preview and its apply agree. 2 decimals.
 */
export function targetPct(rule: Rule, registryId: string, month: string): number {
  return Math.round((rule.marginPct + (rule.marginMaxPct - rule.marginPct) * seeded(`${registryId}|${month}`)) * 100) / 100;
}

/** A spread-out number in [0, 1) fixed by `key`: same key, same number. */
export function seeded(key: string): number {
  let h = 0x811c9dc5; // FNV-1a
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  // finalizer: FNV's high bits barely move when only the last characters differ
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** A reading at or above this share of the rating counts as full load. */
export const FULL_LOAD_SHARE = 0.95;
/** Full-load readings needed before capped hours follow them. */
export const MIN_FULL_LOAD = 12;

/** Full-load hours never go above the rating by more than this, picked per device and month. */
export const OVER_RATING_PCT: [number, number] = [0.1, 0.2];

/**
 * Hours that scaling pushed to the rating take the shape of the turbine's own
 * full-load readings instead of a flat rating: each takes a reading's deviation
 * from their mean, scaled so none goes more than OVER_RATING_PCT above the
 * rating, and they average the rating, so the month total is unchanged.
 * Seeded per hour by `seed`. Returns how many hours were shaped.
 */
export function spreadFullLoad(values: (number | null)[], capped: number[], fullLoadKwh: number[], ratingKwh: number, seed: string, dp: number) {
  const pool = fullLoadKwh.filter((v) => v >= FULL_LOAD_SHARE * ratingKwh);
  if (pool.length < MIN_FULL_LOAD || !capped.length) return 0;
  const [minPct, maxPct] = OVER_RATING_PCT;
  const unit = 10 ** -dp;
  const hi = Math.floor((ratingKwh * (1 + (minPct + (maxPct - minPct) * seeded(`${seed}|cap`)) / 100)) / unit) * unit;
  const picks = capped.map((i) => pool[Math.floor(seeded(`${seed}|${i}`) * pool.length)]);
  const mean = picks.reduce((a, b) => a + b, 0) / picks.length;
  const dev = picks.map((v) => v - mean);
  const top = Math.max(...dev);
  const scale = top > 0 ? Math.min(1, (hi - ratingKwh) / top) : 1;
  const next = dev.map((d) => Math.min(roundTo(ratingKwh + d * scale, dp), hi));
  const lo = Math.min(...next);
  // land the capped hours' sum exactly where it was, one unit at a time within [lo, hi]
  let units = Math.round((capped.length * ratingKwh - next.reduce((a, b) => a + b, 0)) / unit);
  for (let k = 0, stuck = 0; units !== 0 && stuck < next.length; k = (k + 1) % next.length) {
    const v = roundTo(next[k] + Math.sign(units) * unit, dp);
    if (v < lo || v > hi) {
      stuck++;
      continue;
    }
    stuck = 0;
    next[k] = v;
    units -= Math.sign(units);
  }
  capped.forEach((i, k) => (values[i] = next[k]));
  return capped.length;
}

const total = (v: (number | null)[]) => v.reduce<number>((s, x) => s + (x ?? 0), 0);

export function estimateMissing(
  hours: (number | null)[],
  siblings: (number | null)[][],
  ratingKwh: number,
): { estimates: Map<number, number>; calm: number; noEvidence: number } {
  const calmT = CALM_SHARE * ratingKwh;
  const sibAvg = (h: number) => {
    const v = siblings.map((s) => s[h]).filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  // this turbine's usual ratio to its siblings, over producing hours both logged
  let num = 0;
  let den = 0;
  hours.forEach((v, h) => {
    const s = sibAvg(h);
    if (v != null && s != null && s > calmT) {
      num += v;
      den += s;
    }
  });
  const ratio = den > 0 ? num / den : null;
  // mean output per hour of day over the logged hours
  const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  hours.forEach((v, h) => {
    if (v == null) return;
    byHour[h % 24].sum += v;
    byHour[h % 24].n += 1;
  });
  const typical = (h: number) => {
    const b = byHour[h % 24];
    return b.n ? Math.max(b.sum / b.n, 0) : 0;
  };

  const estimates = new Map<number, number>();
  let calm = 0;
  let noEvidence = 0;
  const take = (h: number, v: number) => (v > 0 ? estimates.set(h, Math.min(v, ratingKwh)) : calm++);
  for (let a = 0; a < hours.length; a++) {
    if (hours[a] != null) continue;
    let z = a;
    while (z + 1 < hours.length && hours[z + 1] == null) z++;
    const edges = [hours[a - 1], hours[z + 1]].filter((x): x is number => x != null);
    for (let h = a; h <= z; h++) {
      const s = sibAvg(h);
      if (s != null) {
        if (s <= calmT) calm++;
        else take(h, ratio != null ? ratio * s : typical(h));
      } else if (!edges.length) noEvidence++;
      else if (edges.every((e) => e <= calmT)) calm++;
      else take(h, typical(h));
    }
    a = z;
  }
  return { estimates, calm, noEvidence };
}

/** Put the rounding remainder on the adjustable hour with the most room, so totals land exactly. */
function settle(values: (number | null)[], targetKwh: number, adjustable: number[], ratingKwh: number, dp: number) {
  const residual = roundTo(targetKwh - total(values), dp);
  if (!residual || !adjustable.length) return;
  const i = adjustable.reduce((best, j) => ((values[j] as number) < (values[best] as number) ? j : best), adjustable[0]);
  const v = roundTo((values[i] as number) + residual, dp);
  if (v >= 0 && v <= ratingKwh) values[i] = v;
}

/** Lower a month above the target: one factor below 1 on every producing hour. */
function scaleDown(values: (number | null)[], targetKwh: number, ratingKwh: number, dp: number) {
  const out = [...values];
  const adjustable = out.flatMap((v, i) => (v != null && v > 0 ? [i] : []));
  const base = adjustable.reduce((s, i) => s + (out[i] as number), 0);
  const need = targetKwh - (total(out) - base);
  const factor = base > 0 ? Math.max(need, 0) / base : 1;
  for (const i of adjustable) out[i] = roundTo((out[i] as number) * factor, dp);
  settle(out, targetKwh, adjustable, ratingKwh, dp);
  const hoursRaised = adjustable.filter((i) => out[i] !== values[i]).length;
  const afterKwh = total(out);
  return { values: out, factor, hoursRaised, hoursAtRating: 0, afterKwh, shortKwh: 0 };
}

/** `dp`: decimals to keep, by default the ones the values already use. */
export function scaleMonth(values: (number | null)[], targetKwh: number, ratingKwh: number, dp = decimalsOf(values)) {
  if (total(values) > targetKwh) return scaleDown(values, targetKwh, ratingKwh, dp);
  const out = [...values];
  const adjustable = out.flatMap((v, i) => (v != null && v > 0 && v < ratingKwh ? [i] : []));
  const fixed = total(out.map((v, i) => (adjustable.includes(i) ? null : v)));
  const need = targetKwh - fixed;
  const base = adjustable.reduce((s, i) => s + (out[i] as number), 0);
  const reach = (f: number) => adjustable.reduce((s, i) => s + Math.min((out[i] as number) * f, ratingKwh), 0);
  let factor = 1;
  if (need > base && adjustable.length) {
    if (adjustable.length * ratingKwh <= need) {
      factor = Math.max(...adjustable.map((i) => ratingKwh / (out[i] as number)));
      for (const i of adjustable) out[i] = ratingKwh;
    } else {
      let lo = 1;
      let hi = 2;
      while (reach(hi) < need) hi *= 2;
      for (let k = 0; k < 80; k++) {
        const mid = (lo + hi) / 2;
        if (reach(mid) < need) lo = mid;
        else hi = mid;
      }
      factor = hi;
      for (const i of adjustable) out[i] = roundTo(Math.min((out[i] as number) * factor, ratingKwh), dp);
      settle(out, targetKwh, adjustable.filter((i) => (out[i] as number) < ratingKwh), ratingKwh, dp);
    }
  }
  const hoursRaised = adjustable.filter((i) => (out[i] as number) > (values[i] as number)).length;
  const hoursAtRating = adjustable.filter((i) => out[i] === ratingKwh).length;
  const afterKwh = total(out);
  return { values: out, factor, hoursRaised, hoursAtRating, afterKwh, shortKwh: Math.max(0, roundTo(targetKwh - afterKwh, dp)) };
}

export interface MonthInput {
  /** this month's hourly kWh, null where missing */
  hours: (number | null)[];
  /** sibling turbines' kWh for the same hours */
  siblings: (number | null)[][];
  ratingKwh: number;
  targetKwh: number;
  fill: boolean;
  /** the turbine's own readings (raw), whose full-load hours shape hours scaled to the rating */
  fullLoadKwh?: number[];
  /** seeds the full-load draw, e.g. `registryId|month` */
  seed?: string;
}

export interface MonthResult {
  values: (number | null)[];
  beforeKwh: number;
  afterKwh: number;
  /** still below target after reaching the rating everywhere */
  shortKwh: number;
  filledIdx: number[];
  hoursCalm: number;
  hoursNoEvidence: number;
  fillKwh: number;
  /** energy the scaling step added (negative when scaled down) */
  scaleKwh: number;
  factor: number;
  /** hours the scaling step changed */
  hoursRaised: number;
  hoursAtRating: number;
}

export function reconcileMonth(m: MonthInput): MonthResult {
  const beforeKwh = total(m.hours);
  const values = [...m.hours];
  const result = (over: Partial<MonthResult>): MonthResult => ({
    values, beforeKwh, afterKwh: total(values), shortKwh: 0, filledIdx: [], hoursCalm: 0, hoursNoEvidence: 0,
    fillKwh: 0, scaleKwh: 0, factor: 1, hoursRaised: 0, hoursAtRating: 0, ...over,
  });
  // keep the month's own precision, totals included
  const dp = decimalsOf(m.hours);
  const target = roundTo(m.targetKwh, dp);
  if (roundTo(beforeKwh, dp) === target) return result({});
  if (beforeKwh > target) {
    const s = scaleMonth(values, target, m.ratingKwh, dp);
    return result({ values: s.values, afterKwh: s.afterKwh, scaleKwh: s.afterKwh - beforeKwh, factor: s.factor, hoursRaised: s.hoursRaised });
  }

  let filledIdx: number[] = [];
  let fillKwh = 0;
  let hoursCalm = 0;
  let hoursNoEvidence = 0;
  if (m.fill) {
    const est = estimateMissing(m.hours, m.siblings, m.ratingKwh);
    hoursCalm = est.calm;
    hoursNoEvidence = est.noEvidence;
    filledIdx = [...est.estimates.keys()].sort((a, b) => a - b);
    const sumEst = [...est.estimates.values()].reduce((a, b) => a + b, 0);
    const need = target - beforeKwh;
    if (sumEst >= need && sumEst > 0) {
      // the gaps hold enough: fill them in proportion and leave readings alone
      const k = need / sumEst;
      for (const [h, v] of est.estimates) values[h] = roundTo(v * k, dp);
      settle(values, target, filledIdx, m.ratingKwh, dp);
      return result({ values, filledIdx, hoursCalm, hoursNoEvidence, fillKwh: total(values) - beforeKwh });
    }
    for (const [h, v] of est.estimates) values[h] = roundTo(v, dp);
    fillKwh = total(values) - beforeKwh;
  }
  const s = scaleMonth(values, target, m.ratingKwh, dp);
  const capped = s.values.flatMap((v, i) => (v === m.ratingKwh && m.hours[i] !== m.ratingKwh ? [i] : []));
  spreadFullLoad(s.values, capped, m.fullLoadKwh ?? [], m.ratingKwh, m.seed ?? "", dp);
  s.afterKwh = total(s.values);
  return {
    values: s.values, beforeKwh, afterKwh: s.afterKwh, shortKwh: s.shortKwh, filledIdx, hoursCalm, hoursNoEvidence,
    fillKwh, scaleKwh: s.afterKwh - beforeKwh - fillKwh, factor: s.factor,
    hoursRaised: s.hoursRaised, hoursAtRating: s.hoursAtRating,
  };
}
