"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

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
