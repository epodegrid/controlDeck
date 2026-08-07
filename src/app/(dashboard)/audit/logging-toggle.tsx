"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Switch } from "@/components/switch";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function LoggingToggle({
  scopeType,
  scopeKey,
  on,
  pending,
  label,
}: {
  scopeType: "global" | "team" | "model" | "key";
  scopeKey: string;
  on: boolean;
  pending?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const [isSaving, startTransition] = useTransition();
  const [optimisticOn, setOptimisticOn] = useState(on);

  async function toggle() {
    if (pending) return;
    const next = !optimisticOn;
    // Move the knob immediately; content-logging scope changes are a
    // single-row upsert, and waiting on the round-trip makes the control feel
    // broken even when it is working.
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
    <Switch
      checked={optimisticOn}
      onChange={toggle}
      disabled={pending}
      busy={isSaving}
      label={label ?? `Content logging for ${scopeType}${scopeKey ? ` ${scopeKey}` : ""}`}
    />
  );
}
