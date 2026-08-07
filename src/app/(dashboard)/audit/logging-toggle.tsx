"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function LoggingToggle({
  scopeType,
  scopeKey,
  on,
  pending,
}: {
  scopeType: "global" | "team" | "model" | "key";
  scopeKey: string;
  on: boolean;
  pending?: boolean;
}) {
  const router = useRouter();
  const [isSaving, startTransition] = useTransition();
  const [optimisticOn, setOptimisticOn] = useState(on);

  async function toggle() {
    if (pending) return;
    const next = !optimisticOn;
    setOptimisticOn(next);
    try {
      const res = await fetch(`${API_BASE_URL}/api/audit/logging-config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeType, scopeKey, enabled: next }),
      });
      if (!res.ok) throw new Error(`failed: ${res.status}`);
      startTransition(() => router.refresh());
    } catch (err) {
      setOptimisticOn(!next);
      console.error("Failed to update logging scope", err);
    }
  }

  return (
    <button
      aria-pressed={optimisticOn}
      onClick={toggle}
      disabled={pending || isSaving}
      className={`relative w-9 h-5 rounded-full transition ${
        pending ? "bg-gray-3 cursor-not-allowed" : optimisticOn ? "bg-status-green" : "bg-gray-3"
      } ${isSaving ? "opacity-60" : ""}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          optimisticOn ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
