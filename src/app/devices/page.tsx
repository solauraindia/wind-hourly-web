import { DevicesEditor } from "@/components/DevicesEditor";
import { ImportWorkbook } from "@/components/ImportWorkbook";
import { PageHeader } from "@/components/PageHeader";
import { quarterFromSearch } from "@/lib/pageQuarter";
import { loadDevices } from "@/lib/repo";

export default async function DevicesPage({ searchParams }: PageProps<"/devices">) {
  const quarter = await quarterFromSearch(searchParams);
  const devices = await loadDevices();
  return (
    <>
      <PageHeader
        title="Devices"
        subtitle="Registry that fills meter_id, eac_facility_id and eac_registry_id in every hourly file, and links raw turbine names to devices."
        quarter={quarter.key}
      />
      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-6">
        <ImportWorkbook quarter={quarter.key} />
        <DevicesEditor initial={devices} />
      </div>
    </>
  );
}
