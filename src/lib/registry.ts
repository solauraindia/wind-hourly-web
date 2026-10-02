import type { DeviceMapping } from "./types";

/** Turbine names drift between exports ("ERW 01", "ERW01", "RSMKP-01"); compare loosely. */
export const normAlias = (s: string) => s.toUpperCase().replace(/[\s_-]+/g, "");

/**
 * Pick the registry device for a parsed series.
 *
 * Several sites reuse turbine names (Uthiyur and Ottapidaram both have ERW01),
 * so devices may carry a `sourceHint` that must appear in the source file name.
 * When the file matches any device's hint, only hinted devices are eligible —
 * that keeps Ottapidaram's ERW03 from landing on Uthiyur's ERW03.
 */
export function suggestDevice<T extends DeviceMapping>(alias: string, sourceName: string, devices: T[]): T | null {
  const src = sourceName.toLowerCase();
  const hintMatches = (d: T) => !!d.sourceHint && src.includes(d.sourceHint.toLowerCase());
  const fileIsHinted = devices.some(hintMatches);
  const candidates = devices.filter(
    (d) => normAlias(d.alias) === normAlias(alias) && (fileIsHinted ? hintMatches(d) : !d.sourceHint),
  );
  return candidates.length === 1 ? candidates[0] : null;
}
