"use client";

/**
 * Presentational switch.
 *
 * Geometry matters here and is easy to get wrong: the knob is absolutely
 * positioned and must be anchored with an explicit `left`. Without one it
 * falls back to its static position — and because buttons are `text-align:
 * center` by default, that puts the knob in the middle of the track, so the
 * off state renders looking like on and the travel overshoots the track.
 *
 * Travel is therefore derived from the geometry rather than guessed:
 *   travel = track width − knob − (2 × inset)
 */
const TRACK_W = 42;
const TRACK_H = 24;
const KNOB = 18;
const INSET = 3;
const TRAVEL = TRACK_W - KNOB - INSET * 2;

export function Switch({
  checked,
  onChange,
  disabled = false,
  busy = false,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** In-flight: dim slightly but keep the knob where the user put it. */
  busy?: boolean;
  /** Accessible name, used when there is no adjacent visible label. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent-2 focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
        disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"
      } ${busy ? "opacity-70" : ""}`}
      style={{
        width: TRACK_W,
        height: TRACK_H,
        backgroundColor: checked ? "var(--switch-on)" : "var(--switch-off)",
        transition: "background-color 260ms var(--ease-out-soft)",
      }}
    >
      <span
        aria-hidden="true"
        className="absolute rounded-full bg-white"
        style={{
          left: INSET,
          top: INSET,
          width: KNOB,
          height: KNOB,
          transform: `translateX(${checked ? TRAVEL : 0}px)`,
          // Slight overshoot on the way across — the small elastic settle is
          // what makes the control feel physical rather than merely correct.
          transition: "transform 320ms cubic-bezier(.34,1.56,.64,1)",
          boxShadow: "0 1px 3px rgba(17,17,17,.22)",
        }}
      />
    </button>
  );
}
