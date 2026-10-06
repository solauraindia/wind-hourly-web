"use client";

import { useLinkStatus } from "next/link";
import type { ReactNode, SVGProps } from "react";

export const Spinner = (p: SVGProps<SVGSVGElement>) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden {...p} className={`animate-spin ${p.className ?? ""}`}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

/** Inside a <Link>: shows `pending` (default a spinner) instead of `children` until the navigation commits. */
export function LinkPending({ children, pending }: { children: ReactNode; pending?: ReactNode }) {
  const { pending: isPending } = useLinkStatus();
  return isPending ? (pending ?? <Spinner />) : children;
}
