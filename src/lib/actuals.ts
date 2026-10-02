/** Figures for one device and quarter that come from irec rather than the hourly files (MWh). */
export interface DeviceActuals {
  registryId: string;
  /** devices_monthly_data.actual_gen per month of the quarter */
  actualMWh: [number | null, number | null, number | null];
  /** Σ devices_monthly_data.eligible_gen — eligible credits after banking */
  eligibleMWh: number | null;
  /** Σ issuances.issued_units over the quarter's periods */
  issuedMWh: number | null;
}
