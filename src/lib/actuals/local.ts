import "server-only";
import type { Quarter } from "../quarter";
import { readJson, writeJson } from "../storage";
import type { ActualsProvider, ActualsSnapshot, DeviceActuals } from "./types";

/**
 * Stand-in until the cloud database is wired up: one JSON file per quarter in
 * DATA_DIR/actuals, filled by importing a delivery workbook (Sheet1).
 */
export const localActuals: ActualsProvider = {
  name: "local",
  async getQuarter(quarter: Quarter): Promise<ActualsSnapshot> {
    return readJson<ActualsSnapshot>(`actuals/${quarter.key}.json`, { provider: "local", source: null, updatedAt: null, rows: {} });
  },
};

export async function saveLocalActuals(quarter: Quarter, source: string, rows: Record<string, DeviceActuals>) {
  const existing = await localActuals.getQuarter(quarter);
  const snapshot: ActualsSnapshot = {
    provider: "local",
    source,
    updatedAt: new Date().toISOString(),
    rows: { ...existing.rows, ...rows },
  };
  await writeJson(`actuals/${quarter.key}.json`, snapshot);
}
