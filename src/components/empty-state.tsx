import Link from "next/link";

/**
 * The view a fresh production deployment shows before any traffic exists.
 *
 * A blank panel reads as a broken page, so each empty state says what is
 * missing, why, and what to do about it. This is the first thing an operator
 * sees after installing the chart — it should look deliberate.
 */
export function EmptyState({
  title,
  description,
  hint,
  action,
}: {
  title: string;
  description: string;
  /** Optional secondary line, e.g. the command that would populate this view. */
  hint?: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="rounded-3xl bg-white shadow-soft-2 px-8 py-14 text-center">
      <div
        className="w-10 h-10 rounded-xl bg-gray-1 mx-auto mb-4 flex items-center justify-center"
        aria-hidden="true"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-2">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="text-[15px] font-normal mb-1.5">{title}</h3>
      <p className="text-[12px] text-gray-2 leading-relaxed max-w-md mx-auto">{description}</p>
      {hint ? (
        <p className="text-[11px] font-mono text-gray-2 mt-3 px-3 py-1.5 rounded-lg bg-gray-1 inline-block">{hint}</p>
      ) : null}
      {action ? (
        <div className="mt-5">
          <Link
            href={action.href}
            className="inline-block px-3.5 py-1.5 rounded-lg bg-ink text-paper text-[12px] hover:bg-ink-soft transition"
          >
            {action.label}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown when the router itself can't be reached. Distinct from "no data yet":
 * an operator needs to know the difference between a quiet gateway and a
 * dashboard that has lost its backend.
 */
export function ConnectionError({ detail }: { detail?: string }) {
  return (
    <div className="rounded-3xl bg-white shadow-soft-2 px-8 py-14 text-center">
      <div className="w-10 h-10 rounded-xl bg-status-red/10 mx-auto mb-4 flex items-center justify-center" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-status-red">
          <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <h3 className="text-[15px] font-normal mb-1.5">Can&apos;t reach the router</h3>
      <p className="text-[12px] text-gray-2 leading-relaxed max-w-md mx-auto">
        The dashboard could not load data from the gateway API. Check that the router is running and that
        <code className="font-mono text-[11px] mx-1">API_BASE_URL</code>
        points at it.
      </p>
      {detail ? (
        <p className="text-[11px] font-mono text-gray-2 mt-3 px-3 py-1.5 rounded-lg bg-gray-1 inline-block max-w-full truncate">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
