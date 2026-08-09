"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CostBasis } from "@/lib/api";

/**
 * Same-origin, proxied to the router by src/app/gateway/[...path]/route.ts.
 *
 * Not NEXT_PUBLIC_API_BASE_URL: Next inlines that at build time, so the
 * published image carries the build-time fallback — localhost:4000 — into
 * every browser, whatever the chart sets at run time.
 */
const API_BASE_URL = "/gateway";

export function ModelOverrideForm({
  modelId,
  minReplicas,
  maxReplicas,
  costValue,
  costBasis,
  systemPrompt,
  onClose,
}: {
  modelId: string;
  minReplicas: number;
  maxReplicas: number;
  costValue: number;
  costBasis: CostBasis;
  systemPrompt: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [min, setMin] = useState(String(minReplicas));
  const [max, setMax] = useState(String(maxReplicas));
  const [cost, setCost] = useState(String(costValue));
  const [prompt, setPrompt] = useState(systemPrompt);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/models/${modelId}/override`, {
        method: "PATCH",
        // Survives the page being navigated or reloaded mid-flight. The knob
        // moves optimistically, so without this a user who clicks and moves on
        // immediately sees the change applied and loses it — the browser
        // cancels in-flight requests on navigation.
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          minReplicas: Number(min),
          maxReplicas: Number(max),
          costValue: Number(cost),
          costBasis,
          systemPrompt: prompt,
        }),
      });
      if (!res.ok) throw new Error(`failed: ${res.status}`);
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-3 bg-gray-1/40 p-3.5 mt-2 space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <label className="text-[11px] text-gray-2">
          Min replicas
          <input
            className="mt-1 w-full px-2 py-1 rounded-md border border-gray-3 bg-card font-mono text-[12px] outline-none focus:ring-2 focus:ring-ink/10"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="text-[11px] text-gray-2">
          Max replicas
          <input
            className="mt-1 w-full px-2 py-1 rounded-md border border-gray-3 bg-card font-mono text-[12px] outline-none focus:ring-2 focus:ring-ink/10"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            inputMode="numeric"
          />
        </label>
      </div>
      <label className="text-[11px] text-gray-2 block">
        Cost value
        <input
          className="mt-1 w-full px-2 py-1 rounded-md border border-gray-3 bg-card font-mono text-[12px] outline-none focus:ring-2 focus:ring-ink/10"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          inputMode="decimal"
        />
      </label>
      <label className="text-[11px] text-gray-2 block">
        System prompt
        <textarea
          className="mt-1 w-full px-2 py-1.5 rounded-md border border-gray-3 bg-card font-mono text-[11px] outline-none focus:ring-2 focus:ring-ink/10 resize-y"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      {error ? <p className="text-[11px] text-status-red">{error}</p> : null}
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onClose}
          disabled={isSaving}
          className="px-3 py-1.5 rounded-lg text-[11px] text-gray-2 hover:text-ink transition"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-3 py-1.5 rounded-lg bg-ink text-paper text-[11px] hover:bg-ink-soft transition disabled:opacity-50"
        >
          {isSaving ? "Saving…" : "Save override"}
        </button>
      </div>
    </div>
  );
}
