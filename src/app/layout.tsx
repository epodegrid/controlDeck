import type { Metadata } from "next";
import { Jost, Geist_Mono } from "next/font/google";
import "./globals.css";

/**
 * Jost is a geometric sans in the Futura lineage: wide circular bowls, thin
 * strokes that hold their elegance at display sizes, and a true italic. The
 * design language leans on very light weights at very large sizes for the
 * hero numerals, which a neutral UI grotesque cannot carry — it just reads as
 * heavy. Loading 200–600 covers display through UI without shipping weights
 * nothing uses.
 */
const jost = Jost({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["200", "300", "400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

// Kept for log tails, ids, and anything that must align in columns.
const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "controlDeck · LLM Gateway",
  description: "Self-hosted OpenAI-compatible LLM gateway with Entra SSO, cost tracking, and audit logging.",
};

/**
 * Root layout holds only the document shell. The sidebar/top-bar chrome lives
 * in the (dashboard) route group, so the sign-in screen can render on its own
 * without a nav pointing at pages the visitor cannot reach yet.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${jost.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/*
          Applies the stored theme before first paint. This has to be a
          blocking inline script: anything deferred to hydration means a dark-
          mode user gets a white flash on every navigation. It only ever sets
          an attribute, so there is nothing here to inject.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('cd-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`,
          }}
        />
      </head>
      {/* Browser extensions (Grammarly, password managers) inject attributes
          into <body> before React hydrates, which otherwise reports as a
          hydration mismatch that no application change can fix. */}
      <body className="min-h-full bg-paper text-ink" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
