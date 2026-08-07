import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { getSession } from "@/lib/auth";

/**
 * Chrome for every authenticated view. The session check here is the one that
 * actually verifies the cookie signature — middleware only checks presence.
 */
export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <Sidebar session={session} />
      <div className="flex flex-1 flex-col min-w-0">
        <TopBar session={session} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
