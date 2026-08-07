/**
 * Single-value radial gauge.
 *
 * One measure, one hue — magnitude, not identity, so there is no categorical
 * palette to validate here. The value is printed in the centre, so the arc is
 * reinforcement rather than the only way to read it.
 *
 * The arc is drawn with stroke-dashoffset so it sweeps on mount; the caption
 * hangs off a hairline leader, which is the reference's way of attaching a
 * number to a point without an axis.
 */
export function RingGauge({
  value,
  total,
  label,
  caption,
  size = 220,
  stroke = 6,
  tone = "light",
}: {
  value: number;
  total: number;
  /** Short unit shown under the big centre figure, e.g. "READY". */
  label?: string;
  /** Optional line hanging below the ring, e.g. "443 of 1108". */
  caption?: string;
  size?: number;
  stroke?: number;
  /** `light` = white arc on the accent panel; `ink` = dark arc on white. */
  tone?: "light" | "ink";
}) {
  const safeTotal = total > 0 ? total : 1;
  const pct = Math.max(0, Math.min(100, (value / safeTotal) * 100));

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Leave a gap at the bottom so the ring reads as a gauge, not a pie.
  const sweep = 0.82;
  const arcLength = circumference * sweep;
  const offset = arcLength * (1 - pct / 100);

  const trackColor = tone === "light" ? "rgba(255,255,255,0.28)" : "var(--gray-1)";
  const arcColor = tone === "light" ? "#ffffff" : "var(--ink)";

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          // Start the sweep at the bottom-left so the gap sits at the bottom.
          style={{ transform: "rotate(126deg)" }}
          role="img"
          aria-label={`${Math.round(pct)} percent${label ? ` ${label.toLowerCase()}` : ""}`}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={trackColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arcLength} ${circumference}`}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={arcColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            className="ring-draw"
            style={
              {
                strokeDasharray: `${arcLength} ${circumference}`,
                "--ring-len": `${arcLength}`,
                "--ring-off": `${offset}`,
              } as React.CSSProperties
            }
          />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="flex items-start count-in">
            <span className="stat-hero text-[46px]">{Math.round(pct)}</span>
            <span className="text-[16px] mt-1.5 ml-0.5 opacity-70">%</span>
          </div>
          {label ? (
            <span className="label-eyebrow mt-2 opacity-80" style={{ color: "inherit" }}>
              {label}
            </span>
          ) : null}
        </div>
      </div>

      {caption ? (
        <div className="flex flex-col items-center -mt-3">
          <span className="leader-line h-5" />
          <span className="text-[12px] opacity-75 tabular-nums">{caption}</span>
        </div>
      ) : null}
    </div>
  );
}
