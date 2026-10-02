import "server-only";
import { randomUUID } from "node:crypto";
import type { DetectWarning } from "./parsers/detect";
import type { Series } from "./types";

/**
 * Parsed uploads are held in memory between the "detect" and "process" steps so
 * large raw files are parsed exactly once. Kept on globalThis to survive dev
 * hot reloads; entries expire after an hour.
 */
interface Upload {
  series: Series[];
  warnings: DetectWarning[];
  createdAt: number;
}

const TTL_MS = 60 * 60 * 1000;
const store: Map<string, Upload> = ((globalThis as { __windUploads?: Map<string, Upload> }).__windUploads ??= new Map());

export function putUpload(series: Series[], warnings: DetectWarning[]): string {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.createdAt > TTL_MS) store.delete(k);
  const id = randomUUID();
  store.set(id, { series, warnings, createdAt: now });
  return id;
}

export const getUpload = (id: string) => store.get(id) ?? null;
