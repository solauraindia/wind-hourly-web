// One-off: round stored hourly values to the raw files' precision (see src/lib/precisionBackfill.ts).
// Usage: npm run db:backfill-precision            (dry run: prints what would change)
//        npm run db:backfill-precision -- --apply (writes)
import { appDb } from "@/lib/db";
import { backfillPrecision } from "@/lib/precisionBackfill";

async function main() {
  const apply = process.argv.includes("--apply");
  const changes = await backfillPrecision(appDb(), apply);
  for (const c of changes) {
    const recs = c.reconciliations
      .map((r) => `${r.month} #${r.id} (${r.decimals ? "0.1 kWh" : "whole kWh"}) after ${r.afterKwh[0]} → ${r.afterKwh[1]}, before ${r.beforeKwh[0]} → ${r.beforeKwh[1]}`)
      .join("; ");
    console.log(`${c.quarter} ${c.registryId}: ${c.hoursChanged} hours, total ${c.totalKwh[0]} → ${c.totalKwh[1]} kWh${recs ? ` | ${recs}` : ""}`);
}
console.log(`${changes.length} device-quarters ${apply ? "updated" : "would change (dry run; pass --apply to write)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
