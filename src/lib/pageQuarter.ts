import { defaultQuarterKey, parseQuarter, type Quarter } from "./quarter";

export async function quarterFromSearch(searchParams: Promise<Record<string, string | string[] | undefined>>): Promise<Quarter> {
  const q = (await searchParams).q;
  return parseQuarter(typeof q === "string" ? q : null) ?? parseQuarter(defaultQuarterKey())!;
}
