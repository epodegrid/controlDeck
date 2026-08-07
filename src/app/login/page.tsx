import { redirect } from "next/navigation";
import { authConfig, getSession } from "@/lib/auth";

export const metadata = { title: "Sign in · controlDeck" };

const ERROR_COPY: Record<string, string> = {
  not_configured:
    "Single sign-on is not configured. Set DASHBOARD_ENTRA_TENANT_ID and DASHBOARD_ENTRA_CLIENT_ID, or run with SIM_MODE=true.",
  state_mismatch: "The sign-in attempt could not be verified. Please try again.",
  incomplete_callback: "The sign-in response was incomplete. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; signed_out?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/");

  const { error, signed_out: signedOut } = await searchParams;
  const message = error ? (ERROR_COPY[error] ?? error) : null;
  const configured = Boolean(authConfig.tenantId && authConfig.clientId);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="text-[13px] font-normal tracking-tight">controlDeck</div>
          <div className="text-[12px] text-gray-2 mt-0.5">Self-hosted LLM gateway</div>
        </div>

        <h1 className="text-[20px] font-normal tracking-tight mb-1">Sign in</h1>
        <p className="text-[12px] text-gray-2 leading-relaxed mb-6">
          Access is granted by Entra group membership. This platform issues no credentials of its own.
        </p>

        {signedOut ? (
          <div className="mb-4 px-3 py-2 rounded-lg bg-gray-1 text-[12px] text-gray-2">
            You have been signed out.
          </div>
        ) : null}

        {message ? (
          <div className="mb-4 px-3 py-2 rounded-lg bg-status-red/10 text-[12px] text-status-red leading-relaxed">
            {message}
          </div>
        ) : null}

        {configured ? (
          <a
            href="/api/auth/login"
            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-ink text-paper text-[13px] font-medium hover:opacity-90 transition"
          >
            Continue with Microsoft Entra ID
          </a>
        ) : (
          <div className="px-3 py-3 rounded-lg border border-gray-3 text-[12px] text-gray-2 leading-relaxed">
            <div className="font-medium text-ink mb-1">Not configured</div>
            Set <code className="font-mono text-[11px]">DASHBOARD_ENTRA_TENANT_ID</code> and{" "}
            <code className="font-mono text-[11px]">DASHBOARD_ENTRA_CLIENT_ID</code> to enable sign-in, or start
            with <code className="font-mono text-[11px]">SIM_MODE=true</code> to explore without a tenant.
          </div>
        )}
      </div>
    </div>
  );
}
