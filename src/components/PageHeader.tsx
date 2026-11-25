import type { ReactNode } from "react";
import type { EnergyType } from "@/lib/types";
import { TypeFilter } from "./EnergyType";
import { QuarterSwitcher } from "./QuarterSwitcher";

/** `type`: show the All · Wind · Solar filter with this value (leave out on pages without one). */
export function PageHeader({ title, subtitle, quarter, actions, type }: { title: string; subtitle?: string; quarter: string; actions?: ReactNode; type?: EnergyType | null }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 truncate text-[13px] text-muted">{subtitle}</p>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          {type !== undefined && <TypeFilter value={type} />}
          <QuarterSwitcher value={quarter} />
        </div>
      </div>
    </header>
  );
}
