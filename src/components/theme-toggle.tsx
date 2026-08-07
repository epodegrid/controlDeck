"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "cd-theme";

/**
 * Three-state theme control: light, dark, or follow the OS.
 *
 * "System" is the default and a real option rather than an implicit starting
 * state — someone whose machine switches at sunset should not have the
 * dashboard stuck on whichever mode they last clicked.
 *
 * The chosen theme is written to `data-theme` on <html>, which the stylesheet
 * treats as authoritative over the media query. The initial value is applied
 * by a blocking script in the layout, so this component only has to keep the
 * attribute in step after hydration.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    setTheme(stored ?? "system");
    setMounted(true);
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    if (next === "system") {
      localStorage.removeItem(STORAGE_KEY);
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.setAttribute("data-theme", next);
    }
  }

  const options: { value: Theme; label: string; icon: React.ReactNode }[] = [
    {
      value: "light",
      label: "Light",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      value: "system",
      label: "System",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M9 20h6" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      value: "dark",
      label: "Dark",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M20 13.5A8 8 0 1110.5 4a6.5 6.5 0 009.5 9.5z" strokeLinejoin="round" />
        </svg>
      ),
    },
  ];

  return (
    <div
      className="relative flex items-center gap-0.5 p-0.5 rounded-full bg-gray-1"
      role="radiogroup"
      aria-label="Colour theme"
    >
      {options.map((o) => {
        // Before hydration we don't know the stored value; rendering nothing as
        // selected avoids a flash of the wrong pill.
        const active = mounted && theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => apply(o.value)}
            className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center ${
              active ? "text-ink" : "text-gray-2 hover:text-ink"
            }`}
            style={{
              backgroundColor: active ? "var(--card)" : "transparent",
              boxShadow: active ? "0 1px 3px rgba(17,17,17,.14)" : "none",
              transition: "background-color 260ms var(--ease-out-soft), color 260ms var(--ease-out-soft), box-shadow 260ms var(--ease-out-soft)",
            }}
          >
            <span className="block w-[14px] h-[14px]">{o.icon}</span>
          </button>
        );
      })}
    </div>
  );
}
