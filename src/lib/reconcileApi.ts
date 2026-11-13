import "server-only";
import { requireApiUser, type AppUser } from "./auth/server";
import { IrecUnavailableError, irecUnavailableResponse } from "./irec";
import { parseQuarter, type Quarter } from "./quarter";
import { validateRule, type Rule } from "./reconcile";
import type { ApplyItem, Item, MonthIdx } from "./reconcileStore";

const MAX_ITEMS = 60;

/** Parse and check the common request body of the reconcile routes. */
function parseItems(raw: unknown, withApply: boolean): (Item & Partial<ApplyItem>)[] | string {
  if (!Array.isArray(raw) || !raw.length) return "Pick at least one month";
  if (raw.length > MAX_ITEMS) return `At most ${MAX_ITEMS} months at a time`;
  const out: (Item & Partial<ApplyItem>)[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.registryId !== "string" || r.registryId.length > 40) return "Bad device id";
    if (r.mi !== 0 && r.mi !== 1 && r.mi !== 2) return "Bad month";
    if (typeof r.fill !== "boolean") return "Bad fill option";
    if (withApply && typeof r.processedAt !== "string") return "Missing review timestamp; review again";
    if (r.note !== undefined && typeof r.note !== "string") return "Bad note";
    out.push({ registryId: r.registryId, mi: r.mi as MonthIdx, fill: r.fill, processedAt: r.processedAt as string | undefined, note: r.note as string | undefined });
  }
  return out;
}

export async function reconcileRequest<T>(
  req: Request,
  withApply: boolean,
  run: (args: { user: AppUser; quarter: Quarter; rule: Rule; items: (Item & Partial<ApplyItem>)[] }) => Promise<T>,
): Promise<Response> {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const quarter = parseQuarter(typeof body?.quarter === "string" ? body.quarter : null);
  if (!quarter) return Response.json({ error: "Invalid quarter" }, { status: 400 });
  const rule = validateRule(body?.rule);
  if (typeof rule === "string") return Response.json({ error: rule }, { status: 400 });
  const items = parseItems(body?.items, withApply);
  if (typeof items === "string") return Response.json({ error: items }, { status: 400 });
  try {
    return Response.json(await run({ user, quarter, rule, items }));
  } catch (e) {
    if (e instanceof IrecUnavailableError) return irecUnavailableResponse(e);
    throw e;
  }
}
