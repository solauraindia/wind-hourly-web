import { appDb, irecDb } from "@/lib/db";
import { reconcileRequest } from "@/lib/reconcileApi";
import { previewItems } from "@/lib/reconcileStore";

/** Before/after for the picked device-months under a rule. Writes nothing. */
export async function POST(req: Request) {
  return reconcileRequest(req, false, async ({ quarter, rule, items }) => ({
    plans: await previewItems(appDb(), irecDb(), quarter, items, rule),
  }));
}
