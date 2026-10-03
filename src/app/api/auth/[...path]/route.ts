import { auth } from "@/lib/auth/server";
import { isAllowedAuthPath } from "@/lib/validate";

/**
 * Proxy to Neon Auth, limited to email + password sign-in, sign-out and session
 * reads. The allow-list is checked against the decoded params — the same value
 * the Neon handler forwards upstream — so percent-encoded paths can't slip past.
 * Sign-up and social login must also stay disabled in the Neon console, since
 * the Neon Auth URL itself is reachable without this proxy.
 */
type Ctx = { params: Promise<{ path: string[] }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

const forbidden = () => Response.json({ error: "Not available" }, { status: 403 });

async function guarded(method: "GET" | "POST", req: Request, ctx: Ctx) {
  if (!isAllowedAuthPath((await ctx.params).path)) return forbidden();
  const handlers = auth().handler() as unknown as Record<"GET" | "POST", Handler>;
  return handlers[method](req, ctx);
}

export const GET = (req: Request, ctx: Ctx) => guarded("GET", req, ctx);
export const POST = (req: Request, ctx: Ctx) => guarded("POST", req, ctx);
