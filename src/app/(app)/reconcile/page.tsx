import { IrecBanner } from "@/components/IrecBanner";
import { PageHeader } from "@/components/PageHeader";
import { ReconcileFlow } from "@/components/ReconcileFlow";
import { appDb, irecDb } from "@/lib/db";
import { energyTypeFromSearch, quarterFromSearch } from "@/lib/pageQuarter";
import { loadGrid, type GridRow } from "@/lib/reconcileStore";

export default async function ReconcilePage({ searchParams }: PageProps<"/reconcile">) {
  const [quarter, type] = await Promise.all([quarterFromSearch(searchParams), energyTypeFromSearch(searchParams)]);
  let rows: GridRow[] = [];
  let irecError: string | null = null;
  try {
    rows = (await loadGrid(appDb(), irecDb(), quarter)).filter((r) => !type || r.energyType === type);
  } catch (e) {
    irecError = e instanceof Error ? e.message : String(e);
  }
  return (
    <>
      <PageHeader
        title="Reconcile"
        subtitle="Bring any month's hourly statement to within ±5% of issued: short months are raised (hours at full load follow the turbine's own full-load readings), months above are lowered."
        quarter={quarter.key}
        type={type}
      />
      <div className="mx-auto max-w-[1400px] space-y-5 px-6 py-6 pb-28">
        <IrecBanner error={irecError} />
        {!irecError && <ReconcileFlow key={type ?? "all"} quarter={quarter.key} monthLabels={quarter.monthLabels} rows={rows} />}
      </div>
    </>
  );
}
