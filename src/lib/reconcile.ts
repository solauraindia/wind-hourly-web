/**
 * Reconciliation math: bring a month whose hourly statement is short of the
 * issued (metered) volume up to a target, in two steps.
 *
 * 1. Fill hours the logger missed, from evidence: sibling turbines at the same
 *    site, or this turbine's own readings around the gap. Calm hours (no wind)
 *    and hours without evidence stay empty.
 * 2. Scale: one factor on every producing hour, never above the rating.
 *
 * Pure functions on one month's hours (index = hour of the month, so
 * index % 24 is the hour of day). No randomness: same input, same output.
 */

export interface Rule {
  marginPct: number;
  bandMinPct: number;
  bandMaxPct: number;
}

export const DEFAULT_RULE: Rule = { marginPct: 2, bandMinPct: 1, bandMaxPct: 3 };

/** "Calm" = below this share of the rating. */
export const CALM_SHARE = 0.02;

export function validateRule(input: unknown): Rule | string {
  if (!input || typeof input !== "object") return "Missing reconcile rule";
  const r = input as Record<string, unknown>;
  const [m, lo, hi] = [r.marginPct, r.bandMinPct, r.bandMaxPct];
  if (![m, lo, hi].every((v) => typeof v === "number" && Number.isFinite(v))) return "Rule values must be numbers";
  const rule = { marginPct: m as number, bandMinPct: lo as number, bandMaxPct: hi as number };
  if (rule.bandMinPct < 0 || rule.bandMaxPct > 10) return "Rule values must be between 0% and 10%";
  if (!(rule.bandMinPct <= rule.marginPct && rule.marginPct <= rule.bandMaxPct)) return "The band must contain the target margin";
  return rule;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
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
function settle(values: (number | null)[], targetKwh: number, adjustable: number[], ratingKwh: number) {
  const residual = round3(targetKwh - total(values));
  if (!residual || !adjustable.length) return;
  const i = adjustable.reduce((best, j) => ((values[j] as number) < (values[best] as number) ? j : best), adjustable[0]);
  const v = round3((values[i] as number) + residual);
  if (v <= ratingKwh) values[i] = v;
}

export function scaleMonth(values: (number | null)[], targetKwh: number, ratingKwh: number) {
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
      for (const i of adjustable) out[i] = round3(Math.min((out[i] as number) * factor, ratingKwh));
      settle(out, targetKwh, adjustable.filter((i) => (out[i] as number) < ratingKwh), ratingKwh);
    }
  }
  const hoursRaised = adjustable.filter((i) => (out[i] as number) > (values[i] as number)).length;
  const hoursAtRating = adjustable.filter((i) => out[i] === ratingKwh).length;
  const afterKwh = total(out);
  return { values: out, factor, hoursRaised, hoursAtRating, afterKwh, shortKwh: Math.max(0, round3(targetKwh - afterKwh)) };
}

export interface MonthInput {
  /** this month's hourly kWh, null where missing */
  hours: (number | null)[];
  /** sibling turbines' kWh for the same hours */
  siblings: (number | null)[][];
  ratingKwh: number;
  targetKwh: number;
  fill: boolean;
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
  scaleKwh: number;
  factor: number;
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
  if (beforeKwh >= m.targetKwh) return result({});

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
    const need = m.targetKwh - beforeKwh;
    if (sumEst >= need && sumEst > 0) {
      // the gaps hold enough: fill them in proportion and leave readings alone
      const k = need / sumEst;
      for (const [h, v] of est.estimates) values[h] = round3(v * k);
      settle(values, m.targetKwh, filledIdx, m.ratingKwh);
      return result({ values, filledIdx, hoursCalm, hoursNoEvidence, fillKwh: total(values) - beforeKwh });
    }
    for (const [h, v] of est.estimates) values[h] = round3(v);
    fillKwh = total(values) - beforeKwh;
  }
  const s = scaleMonth(values, m.targetKwh, m.ratingKwh);
  return {
    values: s.values, beforeKwh, afterKwh: s.afterKwh, shortKwh: s.shortKwh, filledIdx, hoursCalm, hoursNoEvidence,
    fillKwh, scaleKwh: s.afterKwh - beforeKwh - fillKwh, factor: s.factor,
    hoursRaised: s.hoursRaised, hoursAtRating: s.hoursAtRating,
  };
}
