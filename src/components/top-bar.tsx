import { api, type Overview } from "@/lib/api";
import type { Session } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";

const healthColor: Record<string, string> = {
  green: "bg-status-green",
  yellow: "bg-status-yellow",
  red: "bg-status-red",
};

/**
 * Health copy is derived from the same overview payload the Home view reads,
 * so the indicator visible on every screen can never disagree with the numbers
 * on the page it is sitting above (PRD §6.9).
 */
function healthLabel(overview: Overview | null): string {
  if (!overview) return "Metrics unavailable";
  if (overview.totalReplicas === 0) return "No models registered";
  switch (overview.systemHealth) {
    case "red":
      return "Degraded";
    case "yellow":
      return overview.queuedRequests > 0
        ? `${overview.queuedRequests} queued`
        : "Replicas scaling";
    default:
      return "All systems normal";
  }
}

export async function TopBar({ session }: { session: Session }) {
  // A dashboard that 500s because the router is briefly unreachable is worse
  // than one that renders with a muted health pill, so this degrades instead.
  let overview: Overview | null = null;
  try {
    overview = await api.getOverview();
  } catch {
    overview = null;
  }

  const dotClass = overview ? healthColor[overview.systemHealth] : "bg-gray-3";

  return (
    <header className="h-16 shrink-0 flex items-center px-8 gap-4 sticky top-0 z-20 bg-paper/80 backdrop-blur-xl">
      {/* Health first: on a second monitor during an incident this is the one
          thing that must be readable without focusing (PRD §10). */}
      <div className="flex items-center gap-2.5 pl-1">
        <span className={`w-[7px] h-[7px] rounded-full ${dotClass} ${overview ? "live-dot" : ""}`} />
        <span className="text-[13px] text-ink/80">{healthLabel(overview)}</span>
        {overview && overview.totalReplicas > 0 ? (
          <span className="text-[12px] text-gray-2 tabular-nums">
            {overview.activeReplicas}/{overview.totalReplicas} replicas
          </span>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <ThemeToggle />

        {session.simulated ? (
          <span
            className="anno-chip"
            title="Sim mode: identities and traffic are simulated. Not a real Entra session."
          >
            Sim mode
          </span>
        ) : null}

        <div className="flex items-center gap-2.5 pl-2">
          <div className="w-8 h-8 rounded-full bg-accent-2 text-white flex items-center justify-center text-[11px] font-medium">
            {session.initials}
          </div>
          <div className="leading-tight hidden sm:block">
            <div className="text-[12.5px] text-ink">{session.name}</div>
            <div className="text-[11px] text-gray-2">{session.email}</div>
          </div>
        </div>

        {!session.simulated ? (
          <a
            href="/api/auth/logout"
            className="px-3 py-1.5 rounded-xl text-[12px] text-gray-2 hover:text-ink hover:bg-gray-1"
          >
            Sign out
          </a>
        ) : null}
      </div>
    </header>
  );
}
