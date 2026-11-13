import { requireApiUser } from "@/lib/auth/server";
import { appDb } from "@/lib/db";
import { parseQuarter } from "@/lib/quarter";
import { ReconciliationNotActiveError, undoReconciliation } from "@/lib/reconcileStore";

/** Undo reconciliations by id: originals back, filled hours removed. */
export async function POST(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => null)) as { quarter?: unknown; ids?: unknown } | null;
  const quarter = parseQuarter(typeof body?.quarter === "string" ? body.quarter : null);
  if (!quarter) return Response.json({ error: "Invalid quarter" }, { status: 400 });
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 60 || !ids.every((i) => Number.isInteger(i))) {
    return Response.json({ error: "Bad reconciliation ids" }, { status: 400 });
  }
  const results: { id: number; ok: boolean; reason?: string }[] = [];
  for (const id of ids as number[]) {
    try {
      await undoReconciliation(appDb(), quarter, id, user.email);
      results.push({ id, ok: true });
    } catch (e) {
      if (!(e instanceof ReconciliationNotActiveError)) throw e;
      results.push({ id, ok: false, reason: e.message });
    }
  }
  return Response.json({ results });
}
