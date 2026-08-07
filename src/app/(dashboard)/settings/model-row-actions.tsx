"use client";

import { useState } from "react";
import type { CostBasis } from "@/lib/api";
import { ModelOverrideForm } from "./model-override-form";

export function ModelRowActions({
  modelId,
  hasOverride,
  minReplicas,
  maxReplicas,
  costValue,
  costBasis,
  systemPrompt,
}: {
  modelId: string;
  hasOverride: boolean;
  minReplicas: number;
  maxReplicas: number;
  costValue: number;
  costBasis: CostBasis;
  systemPrompt: string;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded ${
            hasOverride ? "bg-status-yellow/20 text-status-yellow" : "bg-gray-1 text-gray-3"
          }`}
        >
          {hasOverride ? "OVERRIDE ACTIVE" : "no override"}
        </span>
        <button
          onClick={() => setEditing((v) => !v)}
          className="text-[11px] text-ink/60 hover:text-ink underline transition"
        >
          {editing ? "Close" : "Edit"}
        </button>
      </div>
      {editing ? (
        <ModelOverrideForm
          modelId={modelId}
          minReplicas={minReplicas}
          maxReplicas={maxReplicas}
          costValue={costValue}
          costBasis={costBasis}
          systemPrompt={systemPrompt}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}
