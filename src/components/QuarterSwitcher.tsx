"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { Spinner } from "./Pending";
import { recentQuarters } from "@/lib/quarter";
import { quarterLabel } from "@/lib/format";

export function QuarterSwitcher({ value }: { value: string }) {
  const router = useRouter();
  const path = usePathname();
  const [pending, startTransition] = useTransition();
  const options = recentQuarters(8);
  if (!options.includes(value as never)) options.unshift(value as never);
  return (
    <label className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface pl-3 pr-1 text-sm">
      {pending ? <Spinner className="text-accent" /> : <span className="text-muted">Quarter</span>}
      <select
        className="h-7 cursor-pointer rounded-md bg-transparent pr-1 font-medium outline-none"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const q = e.target.value;
          startTransition(() => router.push(`${path}?q=${q}`));
        }}
      >
        {options.map((q) => (
          <option key={q} value={q}>
            {quarterLabel(q)}
          </option>
        ))}
      </select>
    </label>
  );
}
