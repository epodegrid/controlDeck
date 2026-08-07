/**
 * A run of thin vertical strokes filling to a proportion.
 *
 * Used where a solid progress bar would sit too heavily on a light surface —
 * the ticks read as texture at a glance and as a quantity when looked at. The
 * filled portion carries the accent; the remainder is the inert grey.
 */
export function TickBar({
  fraction,
  count = 34,
  height = 40,
  tone = "accent",
}: {
  /** 0–1. */
  fraction: number;
  count?: number;
  height?: number;
  tone?: "accent" | "light";
}) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * count);

  return (
    <div
      className="tick-bar"
      style={{ height }}
      role="img"
      aria-label={`${Math.round(clamped * 100)} percent`}
    >
      {Array.from({ length: count }, (_, i) => {
        const on = i < filled;
        // A gentle arc across the run so it reads as a considered mark
        // rather than a flat block of lines.
        const h = 45 + Math.sin((i / count) * Math.PI) * 55;
        return (
          <span
            key={i}
            className={`tick ${
              on
                ? tone === "accent"
                  ? "text-accent"
                  : "text-white"
                : tone === "accent"
                  ? "text-gray-3"
                  : "text-white/35"
            }`}
            style={{ height: `${on ? h : h * 0.55}%`, animationDelay: `${i * 14}ms` }}
          />
        );
      })}
    </div>
  );
}
