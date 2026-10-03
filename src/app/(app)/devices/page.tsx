import { DevicesEditor } from "@/components/DevicesEditor";
import { ImportWorkbook } from "@/components/ImportWorkbook";
import { PageHeader } from "@/components/PageHeader";
import { appDb, irecDb } from "@/lib/db";
import { quarterFromSearch } from "@/lib/pageQuarter";
import { IrecBanner } from "@/components/IrecBanner";
import { loadDevicesSafe, mappingsVersion } from "@/lib/store";

export default async function DevicesPage({ searchParams }: PageProps<"/devices">) {
  const quarter = await quarterFromSearch(searchParams);
  const [{ devices, irecError }, version] = await Promise.all([loadDevicesSafe(appDb(), irecDb()), mappingsVersion(appDb())]);
  return (
    <>
      <PageHeader
        title="Devices"
        subtitle="Which irec device each raw turbine name belongs to. Meter, facility and client come from irec."
        quarter={quarter.key}
      />
      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-6">
        <IrecBanner error={irecError} />
        <ImportWorkbook />
        <DevicesEditor initial={devices} version={version} irecUnavailable={!!irecError} />
      </div>
    </>
  );
}
