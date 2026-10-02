import "server-only";
import { cloudActuals } from "./cloud";
import { localActuals } from "./local";
import type { ActualsProvider } from "./types";

export function getActualsProvider(): ActualsProvider {
  return process.env.ACTUALS_PROVIDER === "cloud" ? cloudActuals : localActuals;
}

export type { ActualsSnapshot, DeviceActuals } from "./types";
