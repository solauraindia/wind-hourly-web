import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Sidebar } from "@/components/Sidebar";
import { SignOutButton } from "@/components/SignOutButton";
import { auth, isAllowed } from "@/lib/auth/server";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  await connection(); // per-request: reads the session cookie
  const { data } = await auth().getSession();
  const user = data?.user;
  if (!user) redirect("/sign-in");
  if (!isAllowed(user.email)) {
    return (
      <div className="m-auto max-w-sm px-6 text-center">
        <h1 className="text-lg font-semibold">No access</h1>
        <p className="mt-2 text-sm text-muted">{user.email} is not allowed to use this workspace.</p>
        <div className="mt-5 flex justify-center">
          <SignOutButton />
        </div>
      </div>
    );
  }
  return (
    <>
      <Suspense fallback={<aside className="w-56 shrink-0 border-r border-line bg-surface" />}>
        <Sidebar email={user.email} />
      </Suspense>
      <main className="min-w-0 flex-1">{children}</main>
    </>
  );
}
