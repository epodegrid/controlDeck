"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Same-origin, proxied to the router by src/app/gateway/[...path]/route.ts.
 *
 * Not NEXT_PUBLIC_API_BASE_URL: Next inlines that at build time, so the
 * published image carries the build-time fallback — localhost:4000 — into
 * every browser, whatever the chart sets at run time.
 */
const API_BASE_URL = "/gateway";

const MAX_LINES = 200;

type LogLine = {
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
};

const levelColors: Record<LogLine["level"], string> = {
  info: "text-accent-2",
  debug: "text-gray-3",
  warn: "text-status-yellow",
  error: "text-status-red",
};

const levelLabel: Record<LogLine["level"], string> = {
  info: "INFO",
  debug: "DBG",
  warn: "WARN",
  error: "ERR",
};

export function LogTail({ replicaId }: { replicaId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    const source = new EventSource(`${API_BASE_URL}/api/logs/${replicaId}`);

    source.onmessage = (event) => {
      try {
        const line = JSON.parse(event.data) as LogLine;
        setLines((prev) => {
          const next = [...prev, line];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      } catch (err) {
        console.error("Failed to parse log line", err);
      }
    };

    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };

    return () => {
      source.close();
    };
  }, [replicaId]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div ref={containerRef} className="p-4 font-mono text-[11.5px] leading-relaxed max-h-[520px] overflow-y-auto">
      {lines.length === 0 ? (
        <div className="flex gap-3 -mx-4 px-4 py-0.5 text-white/40 italic">— waiting for events —</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="flex gap-3 hover:bg-white/[0.03] -mx-4 px-4 py-0.5 transition">
            <span className="text-white/30 shrink-0 w-20 tabular-nums">{line.ts}</span>
            <span className={`shrink-0 w-10 ${levelColors[line.level]} font-normal`}>{levelLabel[line.level]}</span>
            <span className="text-accent-2 shrink-0 w-32 truncate">{line.source}</span>
            <span className="text-white/85 flex-1">{line.message}</span>
          </div>
        ))
      )}
      <div className="flex gap-3 -mx-4 px-4 py-0.5 mt-2">
        <span className="text-status-green shrink-0 w-32 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-status-green live-dot" />
          live-tailing
        </span>
        <span className="text-white/40 flex-1 italic">— waiting for next event —</span>
        <span className="inline-block w-2 h-3.5 bg-white/60" style={{ animation: "blink 1.05s steps(1) infinite" }} />
      </div>
    </div>
  );
}
