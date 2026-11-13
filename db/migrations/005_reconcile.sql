-- Reconcile: scale short months up to issued, keeping the original readings.

-- Turbines at one physical site, used as evidence when filling logger gaps.
ALTER TABLE device_mappings ADD COLUMN site text;
UPDATE device_mappings SET site = CASE
  WHEN registry_id IN ('2.7MES20003', '2.7MES20004', '2.7MES20005') THEN 'Uthiyur'
  WHEN registry_id IN ('2.7MES20012', '2.7MES20013') THEN 'Ottapidaram'
  WHEN output_name LIKE 'RSMKP-%' THEN 'RSMKP'
  WHEN output_name LIKE 'SMTKP-%' THEN 'SMTKP'
  WHEN registry_id IN ('2.1MES20005', '2.1MWIND020') THEN 'JPP'
END;

-- Every application of the rule, kept after undo for the record.
CREATE TABLE reconciliations (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registry_id       text NOT NULL REFERENCES device_mappings(registry_id) ON DELETE CASCADE,
  quarter           text NOT NULL CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  month             text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  issued_mwh        numeric(15, 6) NOT NULL,
  actual_mwh        numeric(15, 6),
  rating_mw         numeric(8, 3) NOT NULL,
  before_kwh        numeric(16, 3) NOT NULL,
  after_kwh         numeric(16, 3) NOT NULL,
  short_kwh         numeric(16, 3) NOT NULL DEFAULT 0,
  margin_pct        numeric(5, 2) NOT NULL,
  band_min_pct      numeric(5, 2) NOT NULL,
  band_max_pct      numeric(5, 2) NOT NULL,
  filled            boolean NOT NULL,
  hours_filled      integer NOT NULL,
  hours_calm        integer NOT NULL,
  hours_no_evidence integer NOT NULL,
  fill_kwh          numeric(16, 3) NOT NULL,
  scale_kwh         numeric(16, 3) NOT NULL,
  factor            numeric(12, 6) NOT NULL,
  hours_raised      integer NOT NULL,
  hours_at_rating   integer NOT NULL,
  -- [hour index in quarter, missing reason] of the hours this filled, restored on undo
  filled_missing    jsonb NOT NULL DEFAULT '[]',
  note              text,
  applied_at        timestamptz NOT NULL DEFAULT now(),
  applied_by        text,
  undone_at         timestamptz,
  undone_by         text,
  superseded_at     timestamptz
);
CREATE UNIQUE INDEX reconciliations_one_active ON reconciliations (registry_id, month)
  WHERE undone_at IS NULL AND superseded_at IS NULL;

-- kwh stays the active value (downloads read it); original_kwh holds the
-- reading it replaced, and reconciliation_id marks hours a fill inserted.
ALTER TABLE hourly_values
  ADD COLUMN original_kwh numeric(12, 3),
  ADD COLUMN reconciliation_id integer REFERENCES reconciliations(id);

-- Guards for non-interactive transactions: abort when the data changed since it was read.
CREATE FUNCTION assert_hourly_processed_at(reg text, q text, expected timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hourly_results WHERE registry_id = reg AND quarter = q
                   AND date_trunc('milliseconds', processed_at) = expected) THEN
    RAISE EXCEPTION 'hourly data changed since it was reviewed' USING ERRCODE = '40001';
  END IF;
END
$$;

CREATE FUNCTION assert_reconciliation_active(rid integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reconciliations WHERE id = rid AND undone_at IS NULL AND superseded_at IS NULL) THEN
    RAISE EXCEPTION 'reconciliation is no longer active' USING ERRCODE = '40001';
  END IF;
END
$$;
