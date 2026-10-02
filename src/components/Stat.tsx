import type { ReactNode } from "react";

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warn" | "ok" }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={`num mt-1 text-[22px] font-semibold tracking-tight ${tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : ""}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-faint">{hint}</div>}
    </div>
  );
}
