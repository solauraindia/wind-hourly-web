import type { Quarter } from "../quarter";

/** Generation figures for one device and quarter that come from outside the hourly files. */
export interface DeviceActuals {
  registryId: string;
  /** actual (metered/billed) generation per month of the quarter, MWh */
  actualMWh: [number | null, number | null, number | null];
  /** eligible credits after banking, MWh; null means "same as actual total" */
  eligibleMWh: number | null;
  /** I-RECs issued as per Evident, MWh */
  issuedMWh: number | null;
}

export interface ActualsSnapshot {
  provider: string;
  /** human-readable origin, e.g. a file name or database host */
  source: string | null;
  updatedAt: string | null;
  rows: Record<string, DeviceActuals>;
}

export interface ActualsProvider {
  readonly name: string;
  getQuarter(quarter: Quarter): Promise<ActualsSnapshot>;
}
