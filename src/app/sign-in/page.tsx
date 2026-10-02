"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { IconAlert, IconTurbine } from "@/components/Icons";
import { authClient } from "@/lib/auth/client";

/** Email + password only. Accounts are created in the Neon console; there is no sign-up. */
export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.email({ email, password });
    if (error) {
      setError(error.message || "Invalid email or password");
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="m-auto w-full max-w-[360px] px-6 py-16">
      <div className="mb-8 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-lg bg-accent text-white">
          <IconTurbine width={19} height={19} />
        </span>
        <div className="leading-tight">
          <div className="text-[16px] font-semibold tracking-tight">Wind Hourly</div>
          <div className="text-[12px] text-muted">Meter data studio</div>
        </div>
      </div>
      <form onSubmit={submit} className="card space-y-4 p-6">
        <div>
          <h1 className="text-[17px] font-semibold">Sign in</h1>
          <p className="mt-0.5 text-[13px] text-muted">Use the account your administrator created.</p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">Email</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            <IconAlert className="shrink-0" /> {error}
          </div>
        )}
        <button className="btn btn-primary w-full justify-center" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
