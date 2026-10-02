import { DevicesEditor } from "@/components/DevicesEditor";
import { ImportWorkbook } from "@/components/ImportWorkbook";
import { PageHeader } from "@/components/PageHeader";
import { appDb, irecDb } from "@/lib/db";
import { quarterFromSearch } from "@/lib/pageQuarter";
import { loadDevices } from "@/lib/store";

export default async function DevicesPage({ searchParams }: PageProps<"/devices">) {
  const quarter = await quarterFromSearch(searchParams);
  const devices = await loadDevices(appDb(), irecDb());
  return (
    <>
      <PageHeader
        title="Devices"
        subtitle="Which irec device each raw turbine name belongs to. Meter, facility and client come from irec."
        quarter={quarter.key}
      />
      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-6">
        <ImportWorkbook />
        <DevicesEditor initial={devices} />
      </div>
    </>
  );
}
