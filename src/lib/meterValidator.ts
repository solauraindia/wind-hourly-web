import "server-only";

/**
 * Client for the Meter Data for Bridge T-EACs validator (Flexidao). Files are sent
 * as multipart under `files`, at most 20 per request; the service allows 15
 * requests a minute per IP and says it keeps nothing.
 */
export const VALIDATOR_URL = "https://provider-meter-data-validation.cfesuite.com/api/validate";
export const VALIDATOR_BATCH = 20;
/** issues kept per check, enough to point at the rows */
const ISSUES_KEPT = 10;

export type CheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  issues: { row?: number; column?: string; value?: string; message: string }[];
  totalIssues: number;
}

export interface FileValidation {
  fileName: string;
  status: "pass" | "warn" | "fail" | "error";
  /** set when the service could not validate the file at all */
  error?: string;
  rows?: number;
  localStart?: string;
  localEnd?: string;
  /** checks that did not pass, in the service's order */
  checks: CheckResult[];
  passed: number;
  total: number;
}

interface RawCheck { id: string; name: string; status: CheckStatus; message: string; issues?: Record<string, unknown>[]; totalIssues?: number }
interface RawResult {
  overallStatus: string;
  summary?: { totalRows?: number; meterLocalTimeRanges?: { timeRange?: { start?: string; end?: string } }[] };
  checks?: RawCheck[];
}
interface RawBatchItem { fileName: string; overallStatus?: string; result?: RawResult; error?: string }

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

export function summarise(item: RawBatchItem): FileValidation {
  const r = item.result;
  if (!r || item.error) return { fileName: item.fileName, status: "error", error: item.error ?? "No result returned", checks: [], passed: 0, total: 0 };
  const checks = r.checks ?? [];
  const range = r.summary?.meterLocalTimeRanges?.[0]?.timeRange;
  // the service reports a file with only warnings as "pass"; keep the warnings visible
  const status = r.overallStatus === "fail" ? "fail" : r.overallStatus !== "pass" && r.overallStatus !== "warn" ? "error" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  return {
    fileName: item.fileName,
    status,
    rows: r.summary?.totalRows,
    localStart: range?.start,
    localEnd: range?.end,
    checks: checks
      .filter((c) => c.status === "fail" || c.status === "warn")
      .map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        message: c.message,
        issues: (c.issues ?? []).slice(0, ISSUES_KEPT).map((i) => ({
          row: typeof i.row === "number" ? i.row : undefined, column: str(i.column), value: str(i.value), message: str(i.message) ?? "",
        })),
        totalIssues: c.totalIssues ?? c.issues?.length ?? 0,
      })),
    passed: checks.filter((c) => c.status === "pass").length,
    total: checks.length,
  };
}

/** Validate up to VALIDATOR_BATCH files in one request. */
export async function validateFiles(files: { name: string; data: Uint8Array }[], fetchImpl: typeof fetch = fetch): Promise<FileValidation[]> {
  if (files.length > VALIDATOR_BATCH) throw new Error(`At most ${VALIDATOR_BATCH} files per request`);
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([f.data as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), f.name);
  const res = await fetchImpl(VALIDATOR_URL, { method: "POST", body: form, signal: AbortSignal.timeout(50_000) });
  const body = (await res.json().catch(() => null)) as { results?: RawBatchItem[]; error?: string } | null;
  if (!res.ok) throw new Error(res.status === 429 ? "The validator allows 15 requests a minute; wait a minute and try again" : body?.error ?? `Validator returned ${res.status}`);
  const results = body?.results ?? [];
  return files.map((f) => summarise(results.find((r) => r.fileName === f.name) ?? { fileName: f.name, error: "Not in the validator's response" }));
}
