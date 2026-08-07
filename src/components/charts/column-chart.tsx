/**
 * Time-series column chart.
 *
 * One series, so no legend and no categorical palette: bars are a recessive
 * grey and exactly one — the peak — carries the accent, with a callout pill
 * tethered to it by a hairline. Highlighting a single value is the whole point
 * of the accent; a second highlighted bar would destroy it.
 *
 * Bars are anchored to the baseline with rounded data-ends and a surface gap
 * between them. Hover is CSS-only, which keeps this a server component — no
 * client bundle for a chart that never changes after render.
 */
export type Column = { label: string; value: number };

/**
 * Axis labels arrive from the API as ISO timestamps, which are unreadable on
 * an axis. Formatted in explicit UTC rather than the ambient locale: this
 * renders on the server, and a timezone-dependent string would differ from
 * what the client computes and trip a hydration mismatch.
 */
function formatAxisLabel(label: string): string {
  const parsed = Date.parse(label);
  if (Number.isNaN(parsed)) return label;
  const d = new Date(parsed);
  return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
}

export function ColumnChart({
  data,
  height = 200,
  /** Shown under the last bar, e.g. "Total 10 832". */
  footerLabel,
  footerValue,
  unit = "",
}: {
  data: Column[];
  height?: number;
  footerLabel?: string;
  footerValue?: string;
  unit?: string;
}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[12px] text-gray-2"
        style={{ height }}
      >
        No activity in this window yet.
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const peakIndex = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);

  return (
    <div>
      {/* Headroom above the plot so the callout pill never clips. */}
      <div className="relative flex items-end gap-[2px]" style={{ height, paddingTop: 44 }}>
        {data.map((d, i) => {
          const isPeak = i === peakIndex;
          const barHeight = Math.max((d.value / max) * (height - 44), 3);

          return (
            <div key={`${d.label}-${i}`} className="group relative flex-1 flex flex-col justify-end h-full">
              {/* Callout on the peak: pill + hairline down to the bar. */}
              {isPeak ? (
                <div
                  className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none"
                  style={{ bottom: barHeight }}
                >
                  <span
                    className="anno-chip mb-1"
                    style={{ animation: "rise-in 500ms 420ms var(--ease-out-soft) both" }}
                  >
                    {d.value.toLocaleString()}
                    {unit}
                  </span>
                  <span className="leader-line h-3 text-ink" />
                </div>
              ) : null}

              {/* Hover readout for every other bar. */}
              {!isPeak ? (
                <div
                  className="absolute left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10"
                  style={{ bottom: barHeight + 8 }}
                >
                  <span className="anno-chip-soft bg-ink text-white whitespace-nowrap">
                    {formatAxisLabel(d.label)} · {d.value.toLocaleString()}
                    {unit}
                  </span>
                </div>
              ) : null}

              <div
                className={`w-full bar-grow rounded-t-[4px] transition-colors ${
                  isPeak ? "bg-accent" : "bg-gray-1 group-hover:bg-gray-3"
                }`}
                style={{ height: barHeight, animationDelay: `${i * 45}ms` }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-baseline justify-between mt-4 pt-3">
        <div className="flex gap-6 text-[11px] text-gray-2 tabular-nums">
          {data
            .filter((_, i) => i % Math.ceil(data.length / 5) === 0)
            .map((d, i) => (
              <span key={`${d.label}-tick-${i}`}>{formatAxisLabel(d.label)}</span>
            ))}
        </div>
        {footerValue ? (
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-gray-2">{footerLabel}</span>
            <span className="stat-md text-[18px]">{footerValue}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
