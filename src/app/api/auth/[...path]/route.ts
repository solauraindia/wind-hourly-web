import { auth } from "@/lib/auth/server";

/**
 * Proxy to Neon Auth, restricted to email + password sign-in for existing
 * accounts: sign-up, social/OAuth, magic-link and OTP routes are refused here
 * (also disable them in the Neon console — this is the second lock).
 */
const BLOCKED = [/\/sign-up(\/|$)/, /\/sign-in\/(?!email$)/, /\/link-social/, /\/oauth2?\//, /\/magic-link/, /\/email-otp/];

function blocked(req: Request): boolean {
  const path = new URL(req.url).pathname.replace(/^\/api\/auth/, "");
  return BLOCKED.some((re) => re.test(path));
}

const forbidden = () => Response.json({ error: "Not available" }, { status: 403 });

type Handler = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
const handlers = () => auth().handler() as unknown as { GET: Handler; POST: Handler };

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return blocked(req) ? forbidden() : handlers().GET(req, ctx);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return blocked(req) ? forbidden() : handlers().POST(req, ctx);
}
