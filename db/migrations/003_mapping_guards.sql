-- Swapping two output names in one save must not trip the unique check mid-statement.
ALTER TABLE device_mappings DROP CONSTRAINT device_mappings_output_name_key;
ALTER TABLE device_mappings ADD CONSTRAINT device_mappings_output_name_key UNIQUE (output_name) DEFERRABLE INITIALLY DEFERRED;

-- Fingerprint of the whole mapping table; changes on every insert, update or delete.
CREATE FUNCTION device_mappings_version() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(coalesce(string_agg(registry_id || '@' || updated_at::text, ',' ORDER BY registry_id), ''))
    FROM device_mappings
$$;

-- First statement of every mappings save: aborts the transaction if someone
-- else changed the table since the editor loaded it (optimistic concurrency).
CREATE FUNCTION assert_device_mappings_version(expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF device_mappings_version() IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'device mappings changed since they were loaded' USING ERRCODE = '40001';
  END IF;
END
$$;
