import type { ReactNode } from "react";

/**
 * Page header: small eyebrow, large light title, quiet description.
 *
 * The title sits at 300 weight — the size does the emphasis, not the weight.
 * Left-aligned by default: an ops surface is scanned down the left edge, and
 * centred headings force the eye to re-find the start of every section.
 */
export function SectionHeader({
  tag,
  title,
  description,
  align = "start",
  action,
}: {
  tag: string;
  title: ReactNode;
  description?: ReactNode;
  align?: "center" | "start";
  action?: ReactNode;
}) {
  const center = align === "center";

  return (
    <div
      className={`flex gap-6 mb-10 ${center ? "flex-col items-center text-center" : "items-end justify-between flex-wrap"}`}
    >
      <div className={`flex flex-col gap-3 ${center ? "items-center" : "min-w-0"}`}>
        <span className="section-tag rise-in">{tag}</span>
        <h1 className="text-[38px] leading-[1.08] font-light tracking-tight fade-in-1">{title}</h1>
        {description ? (
          <p className={`text-[13.5px] text-gray-2 leading-relaxed fade-in-2 ${center ? "max-w-xl" : "max-w-2xl"}`}>
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0 fade-in-2">{action}</div> : null}
    </div>
  );
}
