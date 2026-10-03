-- updated_at::text renders in the session TimeZone; use the epoch instead so
-- every client computes the same fingerprint regardless of its settings.
CREATE OR REPLACE FUNCTION device_mappings_version() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(coalesce(string_agg(registry_id || '@' || extract(epoch FROM updated_at)::text, ',' ORDER BY registry_id), ''))
    FROM device_mappings
$$;
