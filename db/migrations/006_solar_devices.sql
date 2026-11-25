-- Solar plants. Their exports name a capacity ("6MW") or a plant code ("SSML")
-- rather than a turbine, so the alias is that label and the source hint (text in
-- the file name) tells plants of the same capacity apart.
INSERT INTO device_mappings (registry_id, alias, output_name, source_hint, site, sort_order) VALUES
  ('5MWSES10023', '5MW',   'Jayajothi-5MW',       'Jayajothi',   NULL,        18),
  ('8MWSES10001', '8MW',   'Jayavilas-8MW',       'Jayavilas',   NULL,        19),
  ('4MWSES10014', '4MW',   'Jayavilas-4MW',       'Jayavilas',   NULL,        20),
  ('10MWSOLA002', '10MW',  'ALC-10MW',            'ALC',         'Kalugur',   21),
  ('6MWSSOLA001', '6MW',   'ALC-6MW',             'ALC',         'Kalugur',   22),
  ('5MWSES10001', 'SSML',  'Sambandam-SSML-5MW',  NULL,          'Sambandam', 23),
  ('2MWSES10001', 'SSTPL', 'Sambandam-SSTPL-2MW', NULL,          'Sambandam', 24),
  ('2MWSES10082', '2MW',   'KM-Knitwear-2MW',     'KM Knitwear', 'Kumulur',   25),
  ('2MWSES10081', '2MW',   'Jayavishnu-2MW',      'Jayavishnu',  'Kumulur',   26),
  ('3MWSES10038', '3MW',   'Acsen-3MW',           'Acsen',       NULL,        27)
ON CONFLICT (registry_id) DO NOTHING;
