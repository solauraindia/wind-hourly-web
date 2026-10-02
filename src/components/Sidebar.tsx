"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { IconDevices, IconTable, IconTurbine, IconUpload } from "./Icons";

const NAV = [
  { href: "/", label: "Hourly mapping", icon: IconUpload },
  { href: "/summary", label: "Quarter summary", icon: IconTable },
  { href: "/devices", label: "Devices", icon: IconDevices },
];

export function Sidebar() {
  const path = usePathname();
  const q = useSearchParams().get("q");
  return (
    <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2.5 px-5 pb-6 pt-5">
        <span className="grid size-8 place-items-center rounded-lg bg-accent text-white">
          <IconTurbine width={18} height={18} />
        </span>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">Wind Hourly</div>
          <div className="text-[11.5px] text-muted">Meter data studio</div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-3">
        <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">Workspace</div>
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link
              key={href}
              href={q ? `${href}?q=${q}` : href}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto border-t border-line px-5 py-4 text-[11.5px] leading-relaxed text-faint">
        Times in Asia/Kolkata (UTC+05:30).
        <br />
        Output follows meter-data-template.
      </div>
    </aside>
  );
}
