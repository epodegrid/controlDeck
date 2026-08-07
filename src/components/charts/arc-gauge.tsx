/**
 * Two-part donut for a share-of-total (failed vs. succeeded).
 *
 * Two segments only, both directly labelled underneath with a dot beside each
 * — identity never rests on colour alone. The segments are separated by a
 * surface gap so they read as distinct arcs rather than one continuous ring.
 */
export function ArcGauge({
  value,
  total,
  size = 132,
  stroke = 7,
}: {
  /** The highlighted portion, e.g. failures. */
  value: number;
  total: number;
  size?: number;
  stroke?: number;
}) {
  const safeTotal = total > 0 ? total : 1;
  const fraction = Math.max(0, Math.min(1, value / safeTotal));

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = circumference * 0.02;

  const valueLen = Math.max(circumference * fraction - gap, 2);
  const restLen = Math.max(circumference * (1 - fraction) - gap, 2);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)" }}
        role="img"
        aria-label={`${(fraction * 100).toFixed(2)} percent of ${total.toLocaleString()}`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="ring-draw"
          style={
            {
              strokeDasharray: `${valueLen} ${circumference}`,
              "--ring-len": `${valueLen}`,
              "--ring-off": "0",
            } as React.CSSProperties
          }
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--gray-1)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDashoffset={-(valueLen + gap)}
          className="ring-draw"
          style={
            {
              strokeDasharray: `${restLen} ${circumference}`,
              "--ring-len": `${restLen}`,
              "--ring-off": "0",
            } as React.CSSProperties
          }
        />
      </svg>

      <div className="absolute inset-0 flex items-center justify-center">
        <span className="anno-chip">{(fraction * 100).toFixed(2)}%</span>
      </div>
    </div>
  );
}
