type Trend = "up" | "down" | "flat";

/**
 * A single headline metric.
 *
 * The delta chip is deliberately neutral rather than red/green. On an ops
 * dashboard almost every metric moves every minute, and colouring each one
 * turns the whole row into a traffic light that the eye stops reading. Colour
 * is reserved for genuine status (a replica down, a request failing); a
 * direction arrow carries the movement without shouting.
 */
const trendGlyph: Record<Trend, string> = {
  up: "↑",
  down: "↓",
  flat: "→",
};

export function KpiTile({
  label,
  value,
  unit,
  delta,
  trend = "flat",
  hint,
  index = 0,
}: {
  label: string;
  value: string | number;
  unit?: string;
  delta?: string;
  trend?: Trend;
  hint?: string;
  /** Position in the row — drives the entrance stagger. */
  index?: number;
}) {
  return (
    <div
      className="tile p-5 lift"
      style={{ animation: `rise-in 620ms ${index * 70}ms var(--ease-out-soft) both` }}
    >
      <p className="label-soft mb-4">{label}</p>

      <div className="flex items-baseline">
        <span className="stat-lg text-[40px] text-ink">{value}</span>
        {unit ? <span className="unit">{unit}</span> : null}
      </div>

      {delta || hint ? (
        <div className="flex items-center justify-between mt-4">
          {delta ? (
            <span className="anno-chip-soft">
              <span className="mr-1 opacity-70">{trendGlyph[trend]}</span>
              {delta}
            </span>
          ) : (
            <span />
          )}
          {hint ? <span className="text-[11px] text-gray-2">{hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
