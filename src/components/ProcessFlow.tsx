"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { computeHourly } from "@/lib/compute";
import { day, quarterLabel } from "@/lib/format";
import { parseQuarter } from "@/lib/quarter";
import { suggestDevice } from "@/lib/registry";
import { FORMAT_LABELS, type Device, type Series, type SeriesInfo } from "@/lib/types";
import { IconAlert, IconCheck, IconFile, IconFolder, IconUpload, IconX } from "./Icons";

interface Picked {
  file: File;
  path: string;
}

interface Detected {
  series: SeriesInfo[];
  warnings: { file: string; message: string }[];
}

function describe(s: Series, devices: Device[]): SeriesInfo {
  const ts = s.kind === "ten-min" ? s.samples.map((x) => x.ts) : s.hours.map(([t]) => t);
  return {
    key: s.key,
    alias: s.alias,
    format: s.format,
    sourceName: s.sourceName,
    points: ts.length,
    firstTs: ts.length ? ts[0] : null,
    lastTs: ts.length ? ts[ts.length - 1] : null,
    suggestedDeviceId: suggestDevice(s.alias, s.sourceName, devices)?.id ?? null,
  };
}

type Phase = "idle" | "detecting" | "mapping" | "processing";

/* Folder drag-and-drop: walk FileSystemEntry trees so whole turbine folders can be dropped. */
async function walk(entry: FileSystemEntry, prefix = ""): Promise<Picked[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    return [{ file, path: prefix + file.name }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    all.push(...batch);
  }
  const nested = await Promise.all(all.map((e) => walk(e, `${prefix}${entry.name}/`)));
  return nested.flat();
}

const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export function ProcessFlow({ devices, quarter }: { devices: Device[]; quarter: string }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detected, setDetected] = useState<Detected | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<string | null>(null);
  // parsed series stay in the browser; only computed hourly arrays are sent
  const parsed = useRef<Series[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // group picked files by their top-level folder for a compact list
  const groups = useMemo(() => {
    const g = new Map<string, { count: number; size: number; folder: boolean }>();
    for (const p of picked) {
      const top = p.path.includes("/") ? p.path.split("/")[0] : p.path;
      const cur = g.get(top) ?? { count: 0, size: 0, folder: p.path.includes("/") };
      cur.count += 1;
      cur.size += p.file.size;
      g.set(top, cur);
    }
    return [...g.entries()];
  }, [picked]);

  function add(items: Picked[]) {
    setPicked((prev) => {
      const seen = new Set(prev.map((p) => p.path));
      return [...prev, ...items.filter((i) => !seen.has(i.path))];
    });
    setDetected(null);
    setPhase("idle");
    setNotice(null);
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x);
    add((await Promise.all(entries.map((en) => walk(en)))).flat());
  }

  async function detect() {
    setPhase("detecting");
    setError(null);
    try {
      // loaded on demand: the Excel/zip readers are only needed on this step
      const { detectAndParse } = await import("@/lib/parsers/detect");
      const inputs = await Promise.all(picked.map(async (p) => ({ name: p.path, data: new Uint8Array(await p.file.arrayBuffer()) })));
      const { series, warnings } = await detectAndParse(inputs);
      parsed.current = series;
      const info = series.map((s) => describe(s, devices)).sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.alias.localeCompare(b.alias));
      setDetected({ series: info, warnings });
      setMapping(Object.fromEntries(info.map((s) => [s.key, s.suggestedDeviceId ?? ""])));
      setPhase("mapping");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  const chosen = Object.entries(mapping).filter(([, d]) => d);
  const duplicates = new Set(chosen.map(([, d]) => d).filter((d, i, a) => a.indexOf(d) !== i));

  async function process() {
    const q = parseQuarter(quarter);
    if (!detected || !q) return;
    setPhase("processing");
    setError(null);
    const errors: string[] = [];
    let ok = 0;
    for (const [i, [seriesKey, deviceId]] of chosen.entries()) {
      const series = parsed.current.find((s) => s.key === seriesKey);
      const name = devices.find((d) => d.id === deviceId)?.outputName ?? deviceId;
      if (!series) continue;
      setProgress(`${i + 1} / ${chosen.length} · ${name}`);
      try {
        const res = await fetch("/api/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(computeHourly(series, deviceId, q)),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? res.statusText);
        ok++;
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setProgress(null);
    setNotice(ok ? `Saved hourly data for ${ok} device${ok === 1 ? "" : "s"} · ${quarterLabel(quarter)}.` : null);
    if (errors.length) setError(errors.join(" · "));
    if (!errors.length) {
      setPicked([]);
      setDetected(null);
      parsed.current = [];
      setPhase("idle");
    } else setPhase("mapping");
    router.refresh();
  }

  const busy = phase === "detecting" || phase === "processing";

  return (
    <section className="card">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <Steps phase={phase} hasFiles={picked.length > 0} />
      </div>

      <div className="space-y-4 p-5">
        {phase !== "mapping" && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-xl border-[1.5px] border-dashed px-6 py-7 text-center transition-colors ${
              dragging ? "border-accent bg-accent-soft" : "border-line-strong bg-surface-2"
            }`}
          >
            <div className="mx-auto grid size-10 place-items-center rounded-full bg-surface text-accent shadow-sm ring-1 ring-line">
              <IconUpload width={18} height={18} />
            </div>
            <p className="mt-3 text-sm font-medium">Drop raw files, folders or .zip archives here</p>
            <p className="mt-1 text-[12.5px] text-muted">
              Regen mean files · SCADA meter readings · active-power trends · hourly production rows · daily 24-hour matrices
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                <IconFile /> Choose files
              </button>
              <button className="btn btn-sm" onClick={() => folderInput.current?.click()} disabled={busy}>
                <IconFolder /> Choose folder
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".xlsx,.txt,.zip"
              hidden
              onChange={(e) => {
                add([...(e.target.files ?? [])].map((f) => ({ file: f, path: f.name })));
                e.target.value = "";
              }}
            />
            <input
              ref={folderInput}
              type="file"
              hidden
              {...({ webkitdirectory: "" } as Record<string, string>)}
              onChange={(e) => {
                add([...(e.target.files ?? [])].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
                e.target.value = "";
              }}
            />
          </div>
        )}

        {groups.length > 0 && phase !== "mapping" && (
          <div className="flex flex-wrap items-center gap-2">
            {groups.map(([name, g]) => (
              <span key={name} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface py-1 pl-2.5 pr-1 text-[12.5px]">
                {g.folder ? <IconFolder className="text-muted" /> : <IconFile className="text-muted" />}
                <span className="max-w-[280px] truncate font-medium">{name}</span>
                <span className="num text-faint">
                  {g.folder ? `${g.count} files · ` : ""}
                  {fmtSize(g.size)}
                </span>
                <button
                  aria-label={`Remove ${name}`}
                  className="grid size-5 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink"
                  onClick={() => setPicked((p) => p.filter((x) => (x.path.includes("/") ? x.path.split("/")[0] : x.path) !== name))}
                >
                  <IconX width={12} height={12} />
                </button>
              </span>
            ))}
            <button className="btn btn-primary btn-sm ml-auto" onClick={detect} disabled={busy}>
              {phase === "detecting" ? "Reading files in your browser…" : "Detect layouts"}
            </button>
          </div>
        )}

        {detected && phase !== "idle" && (
          <MappingTable
            detected={detected}
            devices={devices}
            mapping={mapping}
            duplicates={duplicates}
            onChange={(k, v) => setMapping((m) => ({ ...m, [k]: v }))}
          />
        )}

        {detected && phase !== "idle" && (
          <div className="flex items-center gap-3">
            <button className="btn btn-sm" onClick={() => setPhase("idle")} disabled={busy}>
              Back to files
            </button>
            <span className="text-[12.5px] text-muted">
              {chosen.length} of {detected.series.length} series mapped · hours outside {quarterLabel(quarter)} are ignored
            </span>
            <button className="btn btn-primary ml-auto" onClick={process} disabled={busy || !chosen.length || duplicates.size > 0}>
              {phase === "processing" ? `Saving ${progress ?? "…"}` : `Generate ${chosen.length} hourly file${chosen.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}

        {notice && (
          <div className="flex items-center gap-2 rounded-lg bg-ok-soft px-3 py-2 text-[13px] text-ok">
            <IconCheck /> {notice}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            <IconAlert className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </div>
    </section>
  );
}

function Steps({ phase, hasFiles }: { phase: Phase; hasFiles: boolean }) {
  const current = phase === "mapping" || phase === "processing" ? 2 : hasFiles ? 1 : 0;
  const steps = ["Add files", "Detect layouts", "Map & generate"];
  return (
    <ol className="flex items-center gap-2 text-[13px]">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={`grid size-5 place-items-center rounded-full text-[11px] font-semibold ${
              i < current ? "bg-accent text-white" : i === current ? "bg-accent-soft text-accent ring-1 ring-accent/40" : "bg-surface-2 text-faint ring-1 ring-line"
            }`}
          >
            {i < current ? <IconCheck width={11} height={11} /> : i + 1}
          </span>
          <span className={i === current ? "font-medium" : "text-muted"}>{s}</span>
          {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-line-strong" />}
        </li>
      ))}
    </ol>
  );
}

function MappingTable({
  detected,
  devices,
  mapping,
  duplicates,
  onChange,
}: {
  detected: Detected;
  devices: Device[];
  mapping: Record<string, string>;
  duplicates: Set<string>;
  onChange: (key: string, deviceId: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="th">Series</th>
              <th className="th">Layout</th>
              <th className="th">Source</th>
              <th className="th">Window</th>
              <th className="th text-right">Points</th>
              <th className="th w-[360px]">Device</th>
            </tr>
          </thead>
          <tbody>
            {detected.series.map((s) => {
              const v = mapping[s.key] ?? "";
              const dup = v && duplicates.has(v);
              return (
                <tr key={s.key}>
                  <td className="td font-medium">{s.alias}</td>
                  <td className="td">
                    <span className="chip bg-accent-soft text-accent">{FORMAT_LABELS[s.format]}</span>
                  </td>
                  <td className="td max-w-[240px] truncate text-[13px] text-muted" title={s.sourceName}>
                    {s.sourceName}
                  </td>
                  <td className="td num whitespace-nowrap text-[13px] text-muted">
                    {day(s.firstTs)} → {day(s.lastTs)}
                  </td>
                  <td className="td num text-right text-[13px] text-muted">{s.points.toLocaleString()}</td>
                  <td className="td">
                    <div className="flex items-center gap-2">
                      <select
                        className={`input h-8 text-[13px] ${dup ? "border-danger" : ""}`}
                        value={v}
                        onChange={(e) => onChange(s.key, e.target.value)}
                      >
                        <option value="">— Skip —</option>
                        {devices.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.outputName} · {d.registryId}
                          </option>
                        ))}
                      </select>
                      {v && !dup && s.suggestedDeviceId === v && (
                        <span className="chip shrink-0 bg-ok-soft text-ok" title="Matched automatically">
                          <IconCheck width={11} height={11} /> auto
                        </span>
                      )}
                      {dup && <span className="chip shrink-0 bg-danger-soft text-danger">duplicate</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detected.warnings.length > 0 && (
        <details className="rounded-lg border border-line bg-warn-soft/60 px-3 py-2 text-[13px]">
          <summary className="cursor-pointer font-medium text-warn">
            {detected.warnings.length} file{detected.warnings.length === 1 ? "" : "s"} skipped
          </summary>
          <ul className="mt-2 space-y-1 text-muted">
            {detected.warnings.map((w, i) => (
              <li key={i}>
                <span className="font-medium text-ink">{w.file}</span> — {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
