import type { CSSProperties } from "react";
import {
  badgeText,
  getDashboardFigure,
  highlightKey,
  parseHighlight,
  type DashboardFigureName,
} from "@/lib/dashboard-figures";
import { figureComponents } from "./dashboard-figures";

/**
 * `<DashboardFigure name="environment-variables" highlight="nav:1, add-new:2" caption="..." />`:
 * a dashboard screen drawn in code instead of a screenshot (registry: lib/dashboard-figures.ts).
 * Drawn at the dashboard's real size and scaled to the column by CSS (app/dashboard-figures.css).
 * One image to assistive tech, labelled with the registry's description and its numbered badges.
 */
export function DashboardFigure({
  name,
  caption,
  highlight,
}: {
  name: string;
  caption?: string;
  highlight?: string;
}) {
  const meta = getDashboardFigure(name);
  if (!meta)
    throw new Error(`<DashboardFigure>: no figure named "${name}" in lib/dashboard-figures.ts`);
  const Figure = figureComponents[name as DashboardFigureName];
  const marks = parseHighlight(name, highlight);
  // parseHighlight allows only [a-z0-9-] marks and [A-Za-z0-9 .-] labels, so these are safe in CSS.
  // The key, not the raw value: a value wrapped over two lines would break the selector.
  const key = highlightKey(marks);
  const scope = `.dash-figure[data-figure="${name}"][data-highlight="${key}"]`;
  const badges = badgeText(marks);
  const css = marks
    .map(
      ({ mark, label }) =>
        `${scope} [data-mark="${mark}"]{outline:3px solid var(--color-figure-mark);outline-offset:3px}` +
        (label ? `${scope} [data-mark="${mark}"]::after{content:"${label}";display:grid}` : "")
    )
    .join("");
  const size = {
    "--fig-w": `${meta.width}px`,
    "--fig-h": `${meta.height}px`,
    "--fig-ratio": `${meta.width} / ${meta.height}`,
  } as CSSProperties;

  return (
    <figure
      className="dash-figure not-prose my-6"
      data-figure={name}
      data-highlight={key || undefined}
    >
      {/* Capped at the canvas width (plus the border) so a figure narrower than the column has no empty strip. */}
      <div
        className="overflow-hidden rounded-lg border border-fd-border"
        style={{ maxWidth: meta.width + 2 }}
      >
        <div
          role="img"
          aria-label={badges ? `${meta.description} Marked ${badges}.` : meta.description}
          className="dash-figure-viewport"
          style={size}
        >
          <div className="dash-figure-canvas">
            <Figure />
          </div>
        </div>
      </div>
      {css && <style>{css}</style>}
      {caption && (
        <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
