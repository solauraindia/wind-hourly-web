import { defaultQuarterKey, parseQuarter, type Quarter } from "./quarter";
import { parseEnergyType, type EnergyType } from "./types";

export async function quarterFromSearch(searchParams: Promise<Record<string, string | string[] | undefined>>): Promise<Quarter> {
  const q = (await searchParams).q;
  return parseQuarter(typeof q === "string" ? q : null) ?? parseQuarter(defaultQuarterKey())!;
}

export async function energyTypeFromSearch(searchParams: Promise<Record<string, string | string[] | undefined>>): Promise<EnergyType | null> {
  return parseEnergyType((await searchParams).type);
}
