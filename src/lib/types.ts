/** Input layouts the parsers understand. Every new vendor export becomes one more entry. */
export type SourceFormat =
  | "regen-mean" // Regen Powertech daily 10-min "mean" files (txt or xlsx), cumulative register
  | "scada-meter-reading" // "Meter Reading\Operational Data" export: stacked turbines, lifetime register + power
  | "power-trend" // "Analogue Value Trending": 10-min average kW per turbine column, interval-END stamps
  | "hourly-long" // one row per hour: Turbine No | Date & Time | Production (kWh)
  | "daily-matrix"; // one row per turbine-day with hour columns 1..24 (kWh)

export const FORMAT_LABELS: Record<SourceFormat, string> = {
  "regen-mean": "Regen 10-min mean files",
  "scada-meter-reading": "SCADA meter reading (stacked)",
  "power-trend": "10-min active power trend",
  "hourly-long": "Hourly production rows",
  "daily-matrix": "Daily × 24-hour matrix",
};

/** A 10-minute sample keyed by naive-local interval START. */
export interface TenMinSample {
  ts: number;
  /** cumulative energy register, kWh */
  reg: number | null;
  /** average active power over the 10 minutes, kW */
  pw: number | null;
}

export type Series =
  | {
      kind: "ten-min";
      key: string;
      alias: string;
      format: SourceFormat;
      sourceName: string;
      /** set when the register is a bare 6-digit counter that wraps at this value */
      registerModulo?: number;
      /** true when there is no register and hourly energy comes from power only */
      powerOnly?: boolean;
      samples: TenMinSample[];
    }
  | {
      kind: "hourly";
      key: string;
      alias: string;
      format: SourceFormat;
      sourceName: string;
      /** hourly kWh keyed by naive-local hour start */
      hours: [number, number][];
      /** hours that exist in the source but are blank */
      blankHours: number[];
    };

export interface SeriesInfo {
  key: string;
  alias: string;
  format: SourceFormat;
  sourceName: string;
  points: number;
  firstTs: number | null;
  lastTs: number | null;
  suggestedDeviceId: string | null;
}

/** App-side mapping for one irec device (table device_mappings). */
export interface DeviceMapping {
  /** irec devices.device_meta_id — also the eac_registry_id written to the files */
  registryId: string;
  /** turbine name as it appears in the raw exports, e.g. "ERW01" */
  alias: string;
  /** output file stem, e.g. "Ottapidaram-ERW01" */
  outputName: string;
  /** case-insensitive substring of the source file/folder name that disambiguates identical aliases */
  sourceHint?: string;
}

/** Mapping joined with irec master data — what the UI and the output files use. */
export interface Device extends DeviceMapping {
  /** = registryId; kept as a separate name for readability at call sites */
  id: string;
  client: string;
  meterId: string;
  facilityId: string;
  /** false when the registry id no longer exists in irec */
  inIrec: boolean;
}

export interface HourlyResult {
  registryId: string;
  quarter: string;
  format: SourceFormat;
  sourceName: string;
  hoursInQuarter: number;
  hoursWritten: number;
  hoursEstimated: number;
  hoursMissing: number;
  totalMWh: number;
  monthlyMWh: [number, number, number];
  /** per-day share of hours present (0..1), one entry per quarter day */
  dailyCoverage: number[];
  /** per-day MWh, one entry per quarter day */
  dailyMWh: number[];
  processedAt: string;
  processedBy: string | null;
}
