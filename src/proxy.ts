import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";

/** Everything except the sign-in page, the auth API and static assets requires a session. */
export default function proxy(req: NextRequest) {
  return auth().middleware({ loginUrl: "/sign-in" })(req);
}

export const config = {
  matcher: ["/((?!api/auth|sign-in|_next/static|_next/image|favicon.ico).*)"],
};
