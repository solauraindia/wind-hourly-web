"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth/client";

export function SignOutButton({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={compact ? "text-[12px] font-medium text-muted hover:text-ink" : "btn btn-sm"}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
