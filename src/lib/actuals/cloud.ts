import "server-only";
import type { Quarter } from "../quarter";
import type { ActualsProvider, ActualsSnapshot } from "./types";

/**
 * Cloud database provider — placeholder.
 *
 * To wire it up:
 *   1. set ACTUALS_PROVIDER=cloud and ACTUALS_DATABASE_URL in .env.local
 *   2. replace the body of getQuarter with a query that returns, per device
 *      (keyed by eac_registry_id), the three monthly actuals, the eligible
 *      credits after banking and the issued volume for the quarter.
 * Nothing else in the app needs to change: the summary only sees ActualsSnapshot.
 */
export const cloudActuals: ActualsProvider = {
  name: "cloud",
  async getQuarter(quarter: Quarter): Promise<ActualsSnapshot> {
    if (!process.env.ACTUALS_DATABASE_URL) {
      throw new Error("ACTUALS_PROVIDER=cloud but ACTUALS_DATABASE_URL is not set");
    }
    throw new Error(`Cloud actuals for ${quarter.key}: schema not defined yet — implement src/lib/actuals/cloud.ts`);
  },
};
