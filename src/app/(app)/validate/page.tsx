import { IrecBanner } from "@/components/IrecBanner";
import { PageHeader } from "@/components/PageHeader";
import { ValidateFlow, type ValidateRow } from "@/components/ValidateFlow";
import { appDb, irecDb } from "@/lib/db";
import { quarterFromSearch } from "@/lib/pageQuarter";
import { activeReconciliations } from "@/lib/reconcileStore";
import { loadDevicesSafe, loadResults } from "@/lib/store";
import { simulatePlaceholders } from "@/lib/output";

export default async function ValidatePage({ searchParams }: PageProps<"/validate">) {
  const quarter = await quarterFromSearch(searchParams);
  const [{ devices, irecError }, results, recs] = await Promise.all([
    loadDevicesSafe(appDb(), irecDb()), loadResults(appDb(), quarter.key), activeReconciliations(appDb(), quarter.key),
  ]);
  const monthLabel = (month: string) => quarter.monthLabels[quarter.months.findIndex(([y, m]) => month === `${y}-${String(m).padStart(2, "0")}`)];
  const rows: ValidateRow[] = devices
    .filter((d) => results[d.registryId])
    .map((d) => ({
      registryId: d.registryId,
      outputName: d.outputName,
      client: d.client,
      hoursMissing: results[d.registryId].hoursMissing,
      reconciled: [...recs.values()].filter((r) => r.registryId === d.registryId).map((r) => monthLabel(r.month)),
    }));
  return (
    <>
      <PageHeader
        title="Validate"
        subtitle="Run the hourly files through the Meter Data for Bridge T-EACs validator, exactly as they download, reconciled months included."
        quarter={quarter.key}
      />
      <div className="mx-auto max-w-[1400px] space-y-5 px-6 py-6 pb-16">
        <IrecBanner error={irecError} />
        <ValidateFlow quarter={quarter.key} compact={quarter.compact} rows={rows} simulate={simulatePlaceholders()} />
      </div>
    </>
  );
}
