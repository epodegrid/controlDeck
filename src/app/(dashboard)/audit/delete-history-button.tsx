"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Same-origin, proxied to the router by src/app/gateway/[...path]/route.ts.
 *
 * Not NEXT_PUBLIC_API_BASE_URL: Next inlines that at build time, so the
 * published image carries the build-time fallback — localhost:4000 — into
 * every browser, whatever the chart sets at run time.
 */
const API_BASE_URL = "/gateway";

export function DeleteHistoryButton({ olderThanDays = 30 }: { olderThanDays?: number }) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleClick() {
    if (isDeleting) return;
    if (!confirm(`Delete audit history older than ${olderThanDays} days? This cannot be undone.`)) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/audit/delete`, {
        method: "POST",
        // Survives the page being navigated or reloaded mid-flight. The knob
        // moves optimistically, so without this a user who clicks and moves on
        // immediately sees the change applied and loses it — the browser
        // cancels in-flight requests on navigation.
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanDays }),
      });
      if (!res.ok) throw new Error(`failed: ${res.status}`);
      router.refresh();
    } catch (err) {
      console.error("Failed to delete audit history", err);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={isDeleting}
      className="px-3 py-1.5 rounded-lg border border-status-red/30 text-status-red text-[12px] hover:bg-status-red/10 transition disabled:opacity-50"
    >
      {isDeleting ? "Deleting…" : `Delete last ${olderThanDays} days`}
    </button>
  );
}
