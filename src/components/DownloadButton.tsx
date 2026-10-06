"use client";

import { useState, type ReactNode } from "react";
import { IconDownload } from "./Icons";
import { Spinner } from "./Pending";

/** Name from `Content-Disposition`, preferring the UTF-8 `filename*` form. */
function fileName(header: string | null, fallback: string): string {
  const star = header?.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1]);
  return header?.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
}

/**
 * Downloads are built on the server when requested, which can take a few seconds.
 * A plain <a href> gives no feedback in that time, so fetch it here and show progress.
 */
export function DownloadButton({ href, className = "btn", title, label, children }: { href: string; className?: string; title?: string; label?: string; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(href);
      if (!res.ok) throw new Error((await res.text()) || `Download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName(res.headers.get("Content-Disposition"), "download");
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`${className} ${error ? "border-danger/40 text-danger" : ""}`}
      onClick={download}
      disabled={busy}
      aria-busy={busy}
      aria-label={label}
      title={error ?? title}
    >
      {busy ? <Spinner /> : <IconDownload />}
      {children}
    </button>
  );
}
