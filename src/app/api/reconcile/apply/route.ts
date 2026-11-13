import { appDb, irecDb } from "@/lib/db";
import { reconcileRequest } from "@/lib/reconcileApi";
import { applyItems, type ApplyItem } from "@/lib/reconcileStore";

/** Apply each picked month on its own; returns applied / partly applied / skipped per month. */
export async function POST(req: Request) {
  return reconcileRequest(req, true, async ({ user, quarter, rule, items }) => ({
    outcomes: await applyItems(appDb(), irecDb(), quarter, items as ApplyItem[], rule, user.email),
  }));
}
