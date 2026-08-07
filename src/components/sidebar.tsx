import Link from "next/link";
import type { Session } from "@/lib/auth";

type NavItem = { label: string; href: string; icon: React.ReactNode; count?: number | string };

const items: NavItem[] = [
  {
    label: "Overview",
    href: "/",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </svg>
    ),
  },
  {
    label: "Models",
    href: "/models",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
        <path d="M12 12l8-4.5M12 12l-8-4.5M12 12v9" />
      </svg>
    ),
  },
  {
    label: "Requests",
    href: "/requests",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Cost",
    href: "/cost",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 3v18M16 7H10a3 3 0 000 6h4a3 3 0 010 6H8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Audit",
    href: "/audit",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9 3h6l3 4v14H6V7l3-4z" />
        <path d="M9 12h6M9 16h4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Monitoring",
    href: "/monitoring",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 17l5-5 4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 7h6v6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "Settings",
    href: "/settings",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
];

export function Sidebar({ session }: { session: Session }) {
  return (
    <aside className="w-56 shrink-0 bg-paper flex flex-col sticky top-0 h-screen px-3 py-6">
      {/* Wordmark: one weight throughout, with the accent carried by a single
          full stop. The reference gets its calm from not colouring the name. */}
      <Link href="/" className="flex items-baseline px-3 mb-8 select-none group">
        <span className="text-[19px] font-light tracking-tight text-ink">controlDeck</span>
        <span className="text-[19px] font-light text-accent-2 ml-px transition-colors group-hover:text-accent">.</span>
      </Link>

      <nav className="flex-1 space-y-0.5 overflow-y-auto">
        {items.map((it, i) => (
          <Link
            key={it.href}
            href={it.href}
            className="group flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-normal text-gray-2 hover:text-ink hover:bg-gray-1 transition-colors"
            style={{ animation: `rise-in 500ms ${i * 40}ms var(--ease-out-soft) both` }}
          >
            <span className="block w-[15px] h-[15px] opacity-60 group-hover:opacity-100 transition-opacity">
              {it.icon}
            </span>
            <span>{it.label}</span>
          </Link>
        ))}
      </nav>

      <div className="px-3 pt-4 mt-4 border-t border-gray-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-status-green live-dot" />
          <span className="text-[11px] text-ink/70">
            {session.simulated ? "Sim session" : "Entra SSO"}
          </span>
        </div>
        <p className="text-[11px] text-gray-2 truncate" title={session.email}>
          {session.email}
        </p>
      </div>
    </aside>
  );
}
