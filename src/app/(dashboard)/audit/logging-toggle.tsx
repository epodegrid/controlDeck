"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Switch } from "@/components/switch";

/**
 * Same-origin, proxied to the router by src/app/gateway/[...path]/route.ts.
 *
 * Not NEXT_PUBLIC_API_BASE_URL: Next inlines that at build time, so the
 * published image carries the build-time fallback — localhost:4000 — into
 * every browser, whatever the chart sets at run time.
 */
const API_BASE_URL = "/gateway";

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
        // Survives the page being navigated or reloaded mid-flight. The knob
        // moves optimistically, so without this a user who clicks and moves on
        // immediately sees the change applied and loses it — the browser
        // cancels in-flight requests on navigation.
        keepalive: true,
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
