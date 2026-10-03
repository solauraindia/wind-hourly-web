import type { DeviceMapping } from "./types";

/* Auth ------------------------------------------------------------------------- */

/**
 * The only Neon Auth endpoints this app needs. Everything else (sign-up, social,
 * magic link, OTP, password reset, account management) is refused.
 */
const AUTH_PATHS = new Set(["sign-in/email", "sign-out", "get-session"]);

/**
 * `segments` must be the *decoded* catch-all params — exactly what the Neon
 * handler joins and forwards upstream — so encodings like `sign%2Dup/email` or
 * `sign-up%2Femail` are judged by what they become, not by the raw URL.
 */
export function isAllowedAuthPath(segments: string[]): boolean {
  return AUTH_PATHS.has(segments.join("/"));
}

export const allowedEmails = () =>
  (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Accounts are created only in the Neon console, and only those listed in
 * ALLOWED_EMAILS get in. Fails closed: an empty list admits nobody, so an
 * account created by any other route never gains access.
 */
export function isAllowed(email: string | null | undefined): boolean {
  return !!email && allowedEmails().includes(email.toLowerCase());
}

/* Device mappings ------------------------------------------------------------- */

/** File stem: safe in a Content-Disposition header, a zip entry and any filesystem. */
export const OUTPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

/** Normalise and validate one mapping; returns an error message or the clean mapping. */
export function cleanMapping(input: Partial<DeviceMapping>): DeviceMapping | string {
  const registryId = String(input.registryId ?? "").trim();
  const alias = String(input.alias ?? "").trim();
  const outputName = String(input.outputName ?? "").trim() || alias;
  const sourceHint = String(input.sourceHint ?? "").trim() || undefined;
  const who = registryId || "(new device)";
  if (!registryId || registryId.length > 40) return `${who}: registry id is required (max 40 characters)`;
  if (!ALIAS_RE.test(alias)) return `${who}: raw alias must be 1–40 letters, digits, spaces, '.', '_' or '-'`;
  if (!OUTPUT_NAME_RE.test(outputName)) return `${who}: output name must be 1–80 letters, digits, '.', '_' or '-' (no spaces or slashes)`;
  if (sourceHint && sourceHint.length > 60) return `${who}: source hint is too long (max 60 characters)`;
  return { registryId, alias, outputName, sourceHint };
}

/** Clean a whole list and reject duplicates; returns an error message or the list. */
export function cleanMappings(input: unknown): DeviceMapping[] | string {
  if (!Array.isArray(input)) return "Expected an array of devices";
  const out: DeviceMapping[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const raw of input) {
    const m = cleanMapping((raw ?? {}) as Partial<DeviceMapping>);
    if (typeof m === "string") return m;
    if (ids.has(m.registryId)) return `Duplicate registry id '${m.registryId}'`;
    if (names.has(m.outputName.toLowerCase())) return `Duplicate output name '${m.outputName}'`;
    ids.add(m.registryId);
    names.add(m.outputName.toLowerCase());
    out.push(m);
  }
  return out;
}

/* HTTP ---------------------------------------------------------------------------- */

/** RFC 6266 attachment header: ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
