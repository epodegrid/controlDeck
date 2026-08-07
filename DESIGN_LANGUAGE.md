# Design Language Reference — Callivio Case Study

**Source inspiration:** Behance gallery 225485473 (Callivio CRM — SaaS & UX UI Design). Mirror its structure and feel; substitute the specific accent palette and device motif to avoid direct reproduction.

## Palette (anchor — keep these)

| Token        | Hex      | Use                                                    |
|--------------|----------|--------------------------------------------------------|
| `--accent`   | `#C9F31C` | KPI pills, highlight bars, "Section" tag chips         |
| `--accent-2` | `#93B4FA` | Primary info panels, gradient anchor                   |
| `--ink`      | `#000000` | Display type, contrast blocks                          |
| `--paper`    | `#FFFFFF` | Page background                                        |
| `--gray-1`   | `#F0F0F0` | Card fills, dividers                                   |
| `--gray-2`   | `#999999` | Muted/secondary text                                   |

**Signature gradient:** `linear(135deg, #93B4FA → #FFFFFF → #C9F31C)` — used as ambient wash behind hero cards and mockups.

**Status semantics (consistent platform-wide):**
- Green `#22C55E` = ready / healthy
- Yellow `#EAB308` = queued / scaling / in-progress
- Red `#EF4444` = failed / down / timeout

## Typography

- **Family:** Urbanist (or fallback: Inter, General Sans, Switzer — geometric grotesque)
- **Display:** very large for hero numbers (`1 108 calls`, `10.8k` — note the space between integer and unit suffix)
- **Headings:** 30px+ weight contrast — bold black paired with thin gray for emotional quotes
- **Body:** 14–15px, gray-500 weight
- **Quoted speech:** oversized opening quote glyph (e.g. `"` at 96–120px) before pull-quotes

## Compositional Rules

1. **Floating device mockups** — a stylized monitor/phone/laptop carrying the dashboard surface, sitting on the page with a soft contact shadow. Single recurring motif, not random screenshots.
2. **Generous whitespace** — at least 80–120px vertical between major sections.
3. **Tiny accent pill above section title** — `Section 1`, `Chapter 4`. Always sits above the title, centered, with a small dot connector underneath.
4. **Dot-grid background texture** — subtle 8–12px dots, ~5% opacity, unifying background device.
5. **Asymmetric, free-floating layout** — not a rigid 12-column grid; mockups and cards intentionally off-axis.
6. **Quote callouts** — large opening quote glyph, then bold black text with key phrase highlighted, then thin gray remainder. Always paired with portrait avatar + name + role underneath.
7. **Stat cards** — huge number + tiny unit label, with circular progress arc or KPI strip.
8. **Section headers** — short label up top, then big display text, then a 1–2 sentence description.

## Component Vocabulary

- **Dashboard shell** — left sidebar nav (collapsible), top bar with user identity + global health dot, main canvas
- **KPI tile** — label + huge value + unit + optional delta chip
- **Bar/column chart** — single highlighted column in accent yellow, others in gray
- **Radial progress** — circular arc with center number
- **Status pill** — colored chip for ready/queued/busy/idle/error
- **Data table** — compact rows with status pill + primary key + meta
- **Log tail panel** — monospace, dark canvas, live-tailing rows
- **Floating mockup frame** — device chrome wrapping the dashboard surface (use sparingly — only the hero/landing surfaces)

## Layout Per View (apply these templates)

- **Overview:** Hero stat row (4 KPIs across) → secondary stat grid → activity timeline → per-model mini-cards. Floating monitor with the dashboard surface as hero above-the-fold.
- **Models:** Card grid, each card shows capability badges as colored chips, replica mini-status (dots), KEDA max-replicas line, cost-value line, "GitOps-managed" vs "Dashboard override" badge in the corner.
- **Requests/Queue:** Two-column — queued (yellow highlight, elapsed wait timer) on left, in-flight on right; row click → drawer with full request details and error code if failed.
- **Cost:** Time-period selector top-right (1h / 24h / 7d / 30d) → by-model breakdown bars → by-caller list → raw token/compute-time table at bottom.
- **Audit:** Filter strip (caller / model / scope / date) → table with status pill + caller + tokens + latency → drawer with full content if logged → "delete last X days" action gated behind SSO only.
- **Monitoring/Logs:** Replica selector sidebar → live-tailing monospace log panel → footer link to Grafana.
- **Settings/Admin:** Sectioned form view — model registration status (Helm base vs override layer, with diff), KEDA config, global defaults, content-logging toggle matrix.

## Motion / Interaction

- Hover on cards: subtle 1–2px lift + shadow deepen, 120ms ease-out
- KPI delta chips: green up-arrow / red down-arrow, slide in from above on value change
- Page transitions: soft 200ms fade, no slide
- Status changes: pill color crossfade 240ms

## Notes on Originality

The structural/architectural principles above (whitespace, floating mockups, dot grid, quote callouts, KPI tiles) are common in modern SaaS case-study work — keep them. To stay clear of direct reproduction:

- Swap the signature yellow to a single different saturated accent if needed (e.g. electric violet `#7C5CFF`)
- Don't reproduce the specific monitor mockup asset — use your own chrome treatment
- Use the type family above but pick a different weight contrast strategy if it feels too close