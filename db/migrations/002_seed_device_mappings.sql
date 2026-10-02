-- Devices delivered in Q2 2026 (from Q2 - Delivery_Detailed.xlsx, Hourly Files_details).
INSERT INTO device_mappings (registry_id, alias, output_name, source_hint, sort_order) VALUES
  ('2.7MES20003', 'ERW01', 'ERW01', NULL, 1),
  ('2.7MES20004', 'ERW02', 'ERW02', NULL, 2),
  ('2.7MES20005', 'ERW03', 'ERW03', NULL, 3),
  ('2.7MES20012', 'ERW01', 'Ottapidaram-ERW01', 'Ottapidaram', 4),
  ('2.7MES20013', 'ERW02', 'Ottapidaram-ERW02', 'Ottapidaram', 5),
  ('1.5MWIND019', 'RSMKP-01', 'RSMKP-01', NULL, 6),
  ('1.5MWIND018', 'RSMKP-02', 'RSMKP-02', NULL, 7),
  ('1.5MWIND017', 'RSMKP-03', 'RSMKP-03', NULL, 8),
  ('1.5MWIND016', 'RSMKP-04', 'RSMKP-04', NULL, 9),
  ('1.5MWIND020', 'RSMKP-05', 'RSMKP-05', NULL, 10),
  ('1.5MWIND021', 'RSMKP-06', 'RSMKP-06', NULL, 11),
  ('2.1MES20005', 'KYS060', 'KYS060', NULL, 12),
  ('2.1MWIND020', 'NVL137', 'NVL137', NULL, 13),
  ('2.1MWIND007', 'NVL242', 'NVL242', NULL, 14),
  ('1.5MWIND022', 'SMTKP-01', 'SMTKP-01', NULL, 15),
  ('1.5MWIND023', 'SMTKP-02', 'SMTKP-02', NULL, 16),
  ('1.5MWIND024', 'SMTKP-03', 'SMTKP-03', NULL, 17)
ON CONFLICT (registry_id) DO NOTHING;
