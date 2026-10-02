import type { ReactNode } from "react";
import { QuarterSwitcher } from "./QuarterSwitcher";

export function PageHeader({ title, subtitle, quarter, actions }: { title: string; subtitle?: string; quarter: string; actions?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 truncate text-[13px] text-muted">{subtitle}</p>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <QuarterSwitcher value={quarter} />
        </div>
      </div>
    </header>
  );
}
