"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { IconAlert, IconCheck, IconUpload } from "./Icons";

export function ImportWorkbook() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/devices/import", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setMsg({
        ok: true,
        text: `${json.added} added, ${json.updated} updated${json.skipped.length ? ` · not in irec, skipped: ${json.skipped.join(", ")}` : ""}.`,
      });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-wrap items-center gap-4 px-5 py-4">
      <div className="min-w-[280px] flex-1">
        <h2 className="text-[15px] font-semibold">Import a delivery workbook</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Adds devices from the <span className="font-medium text-ink">Hourly Files_details</span> sheet (file name → raw alias and
          output name, plus registry id). Registry ids must exist in irec; existing devices are updated.
        </p>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
        <IconUpload /> {busy ? "Importing…" : "Choose .xlsx"}
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
      />
      {msg && (
        <div className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"}`}>
          {msg.ok ? <IconCheck /> : <IconAlert />} {msg.text}
        </div>
      )}
    </section>
  );
}
