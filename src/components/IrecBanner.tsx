import { IconAlert } from "./Icons";

/** Shown when the irec database can't be read: the page still works from the app database. */
export function IrecBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[13px] text-warn">
      <IconAlert className="mt-0.5 shrink-0" />
      <div>
        <div className="font-medium">irec database unavailable — client, meter and facility details are missing.</div>
        <div className="mt-0.5 text-muted">Processing still works; downloads are blocked until irec is back. ({error})</div>
      </div>
    </div>
  );
}
