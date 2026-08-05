import { Link } from "@remix-run/react";
import { safeParseTriggerUri } from "@internal/dashboard-agent-contracts";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";
import {
  GALLERY_PAGES,
  groupsOnPage,
  sectionsInGroup,
  sectionsOnPage,
  type GalleryPageId,
  type GallerySection,
} from "./manifest";

/**
 * The shared shell every dashboard-agent gallery page renders through.
 *
 * `./manifest.ts` decides what a page contains. A manifest row with no renderer shows
 * a loud placeholder instead of vanishing. The screenshot script walks the same
 * manifest and captures each section by its `id`.
 *
 * The parent `storybook` route gates every page on admin.
 */

export const noop = () => undefined;

/** Panel width, matching `DashboardAgent`'s default panel size. */
export const PANEL = "w-[380px]";

// The chat panel's own background, so each state is judged on the surface it ships
// on rather than against a darker page.
const CANVAS = "bg-background-bright";

// The frame a harness draws around transcript content to stand in for the panel. Its
// fill is the canvas colour, so the border is all that separates the two.
export const PANEL_FRAME = "rounded-lg border border-border-bright bg-background-bright";

export function Missing({ what }: { what: string }) {
  return (
    <div className="rounded-md border border-error/50 bg-error/10 px-3 py-2 text-xs text-error">
      No renderer for {what}. The manifest and the gallery are out of sync.
    </div>
  );
}

/**
 * Stand-in for the panel's URI resolver. In the app the host resolves against the real
 * environment; here a fixture resolver keeps the seam without a project route.
 */
export function fixtureResolveUri(uri: string): { label: string; url: string } | null {
  const parsed = safeParseTriggerUri(uri);
  if (!parsed.success) return null;
  return { label: uri.split("/").slice(-1)[0]!, url: "#resolved-by-the-host" };
}

/** States that are wider than the panel. */
const WIDE_SECTIONS = new Set(["diagnosis-badge-matrix", "hero-fullscreen"]);

/**
 * One state. The `id` is the deep-link anchor and the screenshot target, and the
 * element is width-fitted so a capture hugs the component instead of the page.
 */
function Section({
  section,
  states,
}: {
  section: GallerySection;
  states: Record<string, React.ReactNode>;
}) {
  const state = states[section.sectionId];
  return (
    <section id={section.sectionId} className="w-fit scroll-mt-4 space-y-1.5">
      <h3 className="text-sm font-medium text-text-bright">{section.title}</h3>
      <div className={cn(WIDE_SECTIONS.has(section.sectionId) ? "w-auto" : PANEL)}>
        {state ?? <Missing what={`section "${section.sectionId}"`} />}
      </div>
    </section>
  );
}

function ThemeToggle() {
  return (
    <div className="flex items-center gap-1.5">
      {/* classic is still the default theme for most users, so it's in the pack */}
      {(["classic", "dark", "light"] as const).map((theme) => (
        <button
          key={theme}
          type="button"
          onClick={() => document.documentElement.setAttribute("data-theme", theme)}
          className="rounded border border-border-bright bg-background-bright px-2 py-1 text-xs text-text-dimmed transition hover:text-text-bright"
        >
          {theme}
        </button>
      ))}
    </div>
  );
}

/** The other gallery pages, so the set is navigable without the storybook nav. */
function PageLinks({ page }: { page: GalleryPageId }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {GALLERY_PAGES.map((entry) => (
        <Link
          key={entry.id}
          to={`/storybook/${entry.slug}`}
          className={cn(
            "rounded border px-2 py-1 text-xs transition",
            entry.id === page
              ? "border-border-bright bg-tertiary text-text-bright"
              : "border-border-bright bg-background-bright text-text-dimmed hover:text-text-bright"
          )}
        >
          {entry.title}
        </Link>
      ))}
    </div>
  );
}

function Nav({ page }: { page: GalleryPageId }) {
  return (
    <nav className="sticky top-0 space-y-3 self-start py-6 pr-4">
      {groupsOnPage(page).map(({ group, label }) => (
        <div key={group} className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-text-faint">{label}</p>
          <ul className="space-y-0.5">
            {sectionsInGroup(group).map((section) => (
              <li key={section.sectionId}>
                <a
                  href={`#${section.sectionId}`}
                  className="block truncate text-xs text-text-dimmed transition hover:text-text-bright"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * A gallery page: the manifest's sections for `page`, rendered from `states`. Fixtures
 * come from the same data the demo conversations use, so the gallery can't drift from
 * the panel.
 */
export function GalleryPage({
  page,
  states,
}: {
  page: GalleryPageId;
  states: Record<string, React.ReactNode>;
}) {
  const meta = GALLERY_PAGES.find((entry) => entry.id === page)!;
  const sections = sectionsOnPage(page);
  return (
    <div className={cn("grid min-h-full grid-cols-[15rem_1fr] gap-4 px-6", CANVAS)}>
      <Nav page={page} />

      <div className="flex flex-col gap-10 py-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4">
            <Header1>Trigger Agent — {meta.title}</Header1>
            <ThemeToggle />
          </div>
          <PageLinks page={page} />
          <Paragraph variant="small">
            {meta.blurb} {sections.length} states, rendered in isolation at panel width (380px) from
            the demo fixtures in{" "}
            <code className="font-mono text-xs">app/components/dashboard-agent/demo/fixtures</code>.
            The list lives in <code className="font-mono text-xs">manifest.ts</code>, which the
            screenshot script walks too.
          </Paragraph>
          <Paragraph variant="extra-small">
            Run ids, queues, errors and reports are fabricated. Deep links resolve inside a project,
            so here they render as plain text or navigate nowhere. The theme buttons flip{" "}
            <code className="font-mono text-xs">data-theme</code> on the root element, which is how
            the screenshot pack captures both themes.
          </Paragraph>
        </div>

        {groupsOnPage(page).map(({ group, label }) => (
          <div key={group} className="flex flex-col gap-4">
            <Header2 className="border-b border-grid-bright pb-1">{label}</Header2>
            <div className="flex flex-wrap items-start gap-8">
              {sectionsInGroup(group).map((section) => (
                <Section key={section.sectionId} section={section} states={states} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
