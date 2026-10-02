import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Everything the app persists lives under DATA_DIR (default ./data). */
export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

export async function readJson<T>(rel: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path.join(/*turbopackIgnore: true*/ DATA_DIR, rel), "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJson(rel: string, value: unknown): Promise<void> {
  await writeBytes(rel, new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n"));
}

/** Atomic write: temp file + rename, so a crash never leaves half a file. */
export async function writeBytes(rel: string, data: Uint8Array): Promise<void> {
  const full = path.join(/*turbopackIgnore: true*/ DATA_DIR, rel);
  await mkdir(/*turbopackIgnore: true*/ path.dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  await writeFile(/*turbopackIgnore: true*/ tmp, data);
  await rename(/*turbopackIgnore: true*/ tmp, full);
}

export async function readBytes(rel: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(/*turbopackIgnore: true*/ DATA_DIR, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
