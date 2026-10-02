# Wind Hourly

Next.js port of `../wind-data-analysis`. It turns raw wind-turbine exports into
hourly files in the `meter-data-template` layout and builds the quarterly
delivery summary ("Sheet1"). It is built to run on Vercel.

```bash
pnpm install
cp .env.example .env     # fill in the values (see below)
pnpm db:migrate          # create/upgrade the app database tables
pnpm dev                 # http://localhost:3000
pnpm test                # golden + database tests (PGlite, no network)
```

## How it works

- **Raw files never leave the browser.** The browser reads the uploaded files,
  zips or folders, works out the hourly values, and posts one compact array per
  device (about 2,200 numbers). This keeps requests far below Vercel's 4.5 MB
  body limit.
- **No files are stored.** Hourly values are saved in the app database
  (`hourly_values`, with per-run quality details in `hourly_results`). Each
  `.xlsx`, the zip of all files, and the summary export are built on download,
  in kWh or MWh.
- **Device master data, actuals and issuances come live from irec** through a
  read-only role. The app stores only its mapping from raw turbine names to irec
  devices (`device_mappings`).

| Output / summary field | Source |
|---|---|
| `eac_registry_id` | irec `devices.device_meta_id` |
| `meter_id` | irec `devices.htsc_no` |
| `eac_facility_id` | irec `devices.project_description` |
| Client | irec `companies.company_name` |
| Actual generation (monthly) | irec `devices_monthly_data.actual_gen` |
| Eligible credits after banking | Σ irec `devices_monthly_data.eligible_gen` |
| Issued as per Evident | Σ irec `issuances.issued_units` over the quarter |
| Hourly statement | this app, `hourly_values` |

## Workflow

1. **Devices.** Map raw turbine names to irec registry ids, or import a delivery
   workbook's `Hourly Files_details` sheet.
2. **Hourly mapping.** Pick the quarter and drop in the raw files. The app works
   out each file's layout, matches each turbine to a device, and saves the
   hourly values when you click Generate. Downloads have a `MeterData` sheet
   (the template) and a `MissingData` sheet listing every missing or estimated
   hour with its reason.
3. **Quarter summary.** irec actuals, eligible and issued figures against the
   hourly statement, with diff and min. Exports to `.xlsx` with live formulas.

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

## Environment

| Variable | Purpose |
|---|---|
| `IREC_DATABASE_URL` | irec Neon database, read-only role |
| `DATABASE_URL` | app Neon database (pooled connection string) |
| `NEON_AUTH_BASE_URL` | Neon Auth URL of the app project |
| `NEON_AUTH_COOKIE_SECRET` | session cookie signing secret, `openssl rand -base64 32` |
| `ALLOWED_EMAILS` | optional comma-separated allow-list |

## Access

Neon Auth (managed Better Auth), email + password only. There is no sign-up page
or social login. `/api/auth` refuses sign-up, social, magic-link and OTP routes,
and sign-up should also be disabled in the Neon console. Create users in the
Neon console. All pages and APIs require a session (`src/proxy.ts`, and checked
again in each route handler).

## Deploying to Vercel

Add the five environment variables, add the deployment domain to Neon Auth's
trusted origins, and run `pnpm db:migrate` against the app database whenever a
new file appears in `db/migrations/`. Times are Asia/Kolkata (UTC+05:30).
