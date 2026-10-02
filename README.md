# Wind Hourly

Next.js port of `../wind-data-analysis`. It turns raw wind-turbine exports into
hourly files in the `meter-data-template` layout and builds the quarterly
delivery summary ("Sheet1").

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm test         # golden checks against the raw files in ~/Downloads/Hourly Raw Files
pnpm build && pnpm start
```

## Workflow

1. **Devices.** Import a delivery workbook such as `Q2 - Delivery_Detailed.xlsx`.
   The `Hourly Files_details` sheet supplies `meter_id`, `eac_facility_id` and
   `eac_registry_id`. `Sheet1` supplies client names and, if you want them, that
   quarter's actual, eligible and issued figures.
2. **Hourly mapping.** Pick the quarter and drop in raw files, folders or zips.
   The app works out each file's layout, splits it into one series per turbine
   and matches each series to a device. Check the matches, then generate. Each
   file has a `MeterData` sheet (the template) and a `MissingData` sheet listing
   every missing or estimated hour and the reason.
3. **Quarter summary.** Shows actual generation, eligible credits, the hourly
   statement, diff, min and issued for each device. It can be exported to
   `.xlsx` with live formulas.

## Supported input layouts (`src/lib/parsers`)

| Layout | Example | Hourly method |
|---|---|---|
| Regen 10-min mean files (txt/xlsx, folder or zip) | RSMKP-01…06 | register(H+1) − register(H), validated to 0–3000 kWh; if that fails, use the average of 6 power samples (flagged as estimated) |
| SCADA meter reading, turbines stacked in one sheet | uthiur, Ottapidaram | same register method; off-grid timestamps are dropped |
| 10-min active power trend (timestamps mark the interval end) | JPP Mills (NVL137, KYS060) | average of 6 power samples |
| Hourly production rows | NVL242 | used as is |
| Daily × 24-hour matrix | Santhosh Meenakshi (SMTKP) | used as is; checked against Grand Total |

To support a new vendor export, add a parser that returns `Series[]` and a sniff
rule in `detect.ts`.

## Actuals source (cloud DB)

The summary reads actual and eligible figures through `ActualsProvider`
(`src/lib/actuals`). For now `local` reads `data/actuals/<quarter>.json`, which
is filled by the workbook import. To use the cloud database, set
`ACTUALS_PROVIDER=cloud` and implement `src/lib/actuals/cloud.ts` once the schema
and access are known. Nothing else needs to change.

## Data

Everything is stored under `DATA_DIR` (default `./data`): `devices.json`,
`actuals/`, and `quarters/<q>/` (results plus generated files). Times are
Asia/Kolkata (UTC+05:30).
