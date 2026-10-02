import "server-only";
import { createNeonAuth } from "@neondatabase/auth/next/server";

type NeonAuth = ReturnType<typeof createNeonAuth>;
let instance: NeonAuth | null = null;

/** Neon Auth (managed Better Auth). Created lazily so builds don't need the secrets. */
export function auth(): NeonAuth {
  instance ??= createNeonAuth({
    baseUrl: process.env.NEON_AUTH_BASE_URL!,
    cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
  });
  return instance;
}

/**
 * Accounts are created only in the Neon console. Besides an existing session,
 * ALLOWED_EMAILS (comma-separated) can pin access to specific accounts.
 */
export function isAllowed(email: string | null | undefined): boolean {
  const list = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!email && (list.length === 0 || list.includes(email.toLowerCase()));
}

export interface AppUser {
  email: string;
  name: string | null;
}

/** The signed-in, allowed user — or null. */
export async function currentUser(): Promise<AppUser | null> {
  const { data } = await auth().getSession();
  const u = data?.user;
  if (!u || !isAllowed(u.email)) return null;
  return { email: u.email, name: u.name || null };
}

/** For route handlers: the user, or a 401 response to return. */
export async function requireApiUser(): Promise<AppUser | Response> {
  return (await currentUser()) ?? Response.json({ error: "Not signed in" }, { status: 401 });
}
