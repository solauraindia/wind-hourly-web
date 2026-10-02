import "server-only";
import { readBytes, readJson, writeBytes, writeJson } from "./storage";
import type { Device, HourlyResult } from "./types";

/* Device registry ----------------------------------------------------------- */

export const loadDevices = () => readJson<Device[]>("devices.json", []);
export const saveDevices = (devices: Device[]) => writeJson("devices.json", devices);

/* Processed hourly results, one folder per quarter --------------------------- */

const resultsPath = (q: string) => `quarters/${q}/results.json`;
const filePath = (q: string, name: string) => `quarters/${q}/files/${name}`;

export const loadResults = (q: string) => readJson<Record<string, HourlyResult>>(resultsPath(q), {});

export async function saveResult(result: HourlyResult, xlsx: Uint8Array): Promise<void> {
  await writeBytes(filePath(result.quarter, result.fileName), xlsx);
  const all = await loadResults(result.quarter);
  all[result.deviceId] = result;
  await writeJson(resultsPath(result.quarter), all);
}

export async function readOutputFile(q: string, name: string): Promise<Buffer | null> {
  if (name.includes("/") || name.includes("..")) return null;
  return readBytes(filePath(q, name));
}
