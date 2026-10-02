"use client";

import { usePathname, useRouter } from "next/navigation";
import { recentQuarters } from "@/lib/quarter";
import { quarterLabel } from "@/lib/format";

export function QuarterSwitcher({ value }: { value: string }) {
  const router = useRouter();
  const path = usePathname();
  const options = recentQuarters(8);
  if (!options.includes(value as never)) options.unshift(value as never);
  return (
    <label className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface pl-3 pr-1 text-sm">
      <span className="text-muted">Quarter</span>
      <select
        className="h-7 cursor-pointer rounded-md bg-transparent pr-1 font-medium outline-none"
        value={value}
        onChange={(e) => router.push(`${path}?q=${e.target.value}`)}
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
