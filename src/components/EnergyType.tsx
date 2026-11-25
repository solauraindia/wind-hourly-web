"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ENERGY_LABELS, type EnergyType } from "@/lib/types";
import { Spinner } from "./Pending";

/** Wind / Solar tag from irec's project type; nothing when irec has none. */
export function EnergyBadge({ type }: { type: EnergyType | null }) {
  if (!type) return null;
  const tone = type === "solar" ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent";
  return <span className={`inline-block rounded px-1.5 py-px align-middle text-[10.5px] font-semibold uppercase tracking-[0.04em] ${tone}`}>{ENERGY_LABELS[type]}</span>;
}

const OPTIONS: [EnergyType | null, string][] = [[null, "All"], ["wind", ENERGY_LABELS.wind], ["solar", ENERGY_LABELS.solar]];

/** All · Wind · Solar, kept in `?type=` so it survives reloads, quarter switches and navigation. */
export function TypeFilter({ value }: { value: EnergyType | null }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const go = (t: EnergyType | null) => {
    const next = new URLSearchParams(params);
    if (t) next.set("type", t);
    else next.delete("type");
    const qs = next.toString();
    startTransition(() => router.push(qs ? `${path}?${qs}` : path));
  };
  return (
    <div className="flex h-9 items-center gap-0.5 rounded-lg border border-line-strong bg-surface p-1 text-sm" role="group" aria-label="Device type">
      {pending && <Spinner className="mx-1 text-accent" />}
      {OPTIONS.map(([t, label]) => (
        <button
          key={label}
          type="button"
          aria-pressed={value === t}
          disabled={pending}
          onClick={() => go(t)}
          className={`h-7 rounded-md px-2.5 font-medium transition-colors ${value === t ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
