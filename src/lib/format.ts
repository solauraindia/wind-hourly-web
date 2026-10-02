const nf = (d: number) => new Intl.NumberFormat("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const f3 = nf(3);
const f1 = nf(1);
const f0 = nf(0);

export const mwh = (v: number | null | undefined, digits: 0 | 1 | 3 = 3) =>
  v === null || v === undefined ? "—" : (digits === 3 ? f3 : digits === 1 ? f1 : f0).format(v);

export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const pad = (n: number) => String(n).padStart(2, "0");
/** naive-local ms → "01 Apr 2026" */
export function day(ts: number | null): string {
  if (ts === null) return "—";
  const d = new Date(ts);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${pad(d.getUTCDate())} ${mon} ${d.getUTCFullYear()}`;
}

export const quarterLabel = (key: string) => key.replace("-", " ");
