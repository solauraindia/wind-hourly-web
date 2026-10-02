-- App-owned tables. Device master data (ids, meter, facility, client) lives in
-- the read-only irec database; this database only stores what this app produces.

-- How raw turbine names map onto irec devices, and the order of the summary.
CREATE TABLE device_mappings (
  registry_id  text PRIMARY KEY,              -- irec devices.device_meta_id
  alias        text NOT NULL,                 -- turbine name in raw exports, e.g. ERW01
  output_name  text NOT NULL UNIQUE,          -- file stem: <output_name>_hourly_2026Q2.xlsx
  source_hint  text,                          -- substring of the raw file name for repeated aliases
  sort_order   integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);

-- One row per device and quarter: the latest processing run and its data quality.
CREATE TABLE hourly_results (
  registry_id      text NOT NULL REFERENCES device_mappings(registry_id) ON DELETE CASCADE,
  quarter          text NOT NULL CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  format           text NOT NULL,
  source_name      text NOT NULL,
  hours_in_quarter integer NOT NULL,
  hours_written    integer NOT NULL,
  hours_estimated  integer NOT NULL,
  hours_missing    integer NOT NULL,
  total_kwh        numeric(16, 3) NOT NULL,
  monthly_kwh      numeric(16, 3)[] NOT NULL,
  daily_coverage   real[] NOT NULL,             -- share of hours present per quarter day
  daily_kwh        real[] NOT NULL,
  quality          jsonb NOT NULL,              -- missing hours + reasons, estimated hours, 10-min gaps
  processed_at     timestamptz NOT NULL DEFAULT now(),
  processed_by     text,
  PRIMARY KEY (registry_id, quarter)
);

-- The hourly statement itself. The .xlsx files are rendered from this on download.
CREATE TABLE hourly_values (
  registry_id  text NOT NULL REFERENCES device_mappings(registry_id) ON DELETE CASCADE,
  hour_start   timestamptz NOT NULL,
  kwh          numeric(12, 3) NOT NULL,
  estimated    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (registry_id, hour_start)
);
