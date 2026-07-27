/**
 * The gallery's table of contents — one row per state on the storybook page.
 *
 * Two consumers share this file, which is why it holds no imports and no JSX:
 *
 * 1. `route.tsx` renders the gallery *from* it, and fails loudly (a visible
 *    "no renderer" placeholder) for any row it can't render. So the manifest is
 *    the spec, not a description written after the fact.
 * 2. `scripts/agent-ui-screenshots.ts` walks it to capture every state. A node
 *    script can't import a Remix route module (JSX, `~/` aliases, browser-only
 *    deps), but it can import this — hence the no-dependency rule. Keep it that
 *    way.
 *
 * `sectionId` is the DOM `id` of the section element and the screenshot's
 * filename, so it must be URL- and filename-safe and must never change
 * casually — a rename breaks deep links and orphans old screenshots.
 */

/** The gallery's top-level grouping. Screenshots land in a directory per group. */
export type GalleryGroup =
  | "diagnosis"
  | "view-blocks"
  | "investigation"
  | "report"
  | "chart"
  | "watches"
  | "prompts"
  | "intents"
  | "messages";

export type GallerySection = {
  /** DOM id, deep-link anchor and screenshot filename. Stable. */
  sectionId: string;
  /** Human label, shown above the state and in the nav. */
  title: string;
  group: GalleryGroup;
  /**
   * A state that only exists after a click (an expandable tool row's output
   * tab, say). The screenshot script clicks the first element inside the
   * section whose text matches, then captures. Rendering ignores it.
   */
  expandText?: string;
};

/** Group order in the page and the nav. */
export const GALLERY_GROUPS: { group: GalleryGroup; label: string }[] = [
  { group: "diagnosis", label: "Diagnosis card" },
  { group: "view-blocks", label: "View blocks & envelope" },
  { group: "investigation", label: "Investigation card" },
  { group: "report", label: "Report card" },
  { group: "chart", label: "Chart card" },
  { group: "watches", label: "Watch chips" },
  { group: "prompts", label: "Suggested prompts" },
  { group: "intents", label: "Intent bubbles" },
  { group: "messages", label: "Message-level states" },
];

export const MANIFEST: GallerySection[] = [
  // --- Diagnosis card (the one shipped view-catalog card) -------------------
  {
    sectionId: "diagnosis-full-high",
    title: "Full card, high confidence",
    group: "diagnosis",
  },
  {
    sectionId: "diagnosis-external-medium",
    title: "External service, medium confidence",
    group: "diagnosis",
  },
  {
    sectionId: "diagnosis-low-minimal",
    title: "Low confidence, minimal evidence",
    group: "diagnosis",
  },
  {
    sectionId: "diagnosis-demo-first-pass",
    title: "Demo fixture, first pass (revision 0)",
    group: "diagnosis",
  },
  {
    sectionId: "diagnosis-demo-revised",
    title: "Demo fixture, revised (revision 1)",
    group: "diagnosis",
  },
  {
    sectionId: "diagnosis-badge-matrix",
    title: "Badge matrix — every category x confidence",
    group: "diagnosis",
  },

  // --- ViewBlocks: identity, revisions, legacy -----------------------------
  {
    sectionId: "view-blocks-revisions",
    title: "Three same-id revisions collapse to one card",
    group: "view-blocks",
  },
  {
    sectionId: "view-blocks-legacy",
    title: "Legacy blocks with no envelope both render",
    group: "view-blocks",
  },
  {
    sectionId: "view-blocks-mixed",
    title: "Enveloped revisions plus a legacy block",
    group: "view-blocks",
  },

  // --- Investigation card (demo-only until M5) ------------------------------
  {
    sectionId: "investigation-streaming-rev0",
    title: "Streaming, revision 0 — nothing settled",
    group: "investigation",
  },
  {
    sectionId: "investigation-streaming-rev1",
    title: "Streaming, revision 1 — one hypothesis settled",
    group: "investigation",
  },
  {
    sectionId: "investigation-concluded",
    title: "Concluded, collapsed",
    group: "investigation",
  },
  {
    sectionId: "investigation-concluded-expanded",
    title: "Concluded, details expanded",
    group: "investigation",
  },
  {
    sectionId: "investigation-inconclusive",
    title: "Inconclusive — no fix, what to check next",
    group: "investigation",
  },
  {
    sectionId: "investigation-dirty-commit",
    title: "Dirty-commit caveat",
    group: "investigation",
  },

  // --- Report card ---------------------------------------------------------
  // The shipped ReportView first, then the demo mockup it grew out of (kept so a
  // design change can be compared against what was reviewed).
  { sectionId: "report-view-healthy", title: "Healthy — nothing to do", group: "report" },
  {
    sectionId: "report-view-degraded",
    title: "Degraded — env limit saturation, actions wired",
    group: "report",
  },
  {
    sectionId: "report-view-untrustworthy",
    title: "Stale telemetry — verdict unknown, numbers informational",
    group: "report",
  },
  { sectionId: "report-healthy", title: "Demo mockup — healthy", group: "report" },
  { sectionId: "report-degraded", title: "Demo mockup — degraded", group: "report" },

  // --- Chart card ----------------------------------------------------------
  { sectionId: "chart-with-data", title: "With canned rows", group: "chart" },
  { sectionId: "chart-empty", title: "Empty — no data to display", group: "chart" },

  // --- Watch chips ---------------------------------------------------------
  { sectionId: "watches-active", title: "Active — cancellable", group: "watches" },
  { sectionId: "watches-fired", title: "Fired", group: "watches" },
  { sectionId: "watches-expired", title: "Expired", group: "watches" },
  { sectionId: "watches-cancelled", title: "Cancelled", group: "watches" },
  { sectionId: "watches-all-states", title: "All four states in one row", group: "watches" },

  // --- Suggested prompts ---------------------------------------------------
  { sectionId: "prompts-default", title: "Default set, no page context", group: "prompts" },
  {
    sectionId: "prompts-contextual-fresh-failure",
    title: "Contextual — fresh failure first",
    group: "prompts",
  },
  { sectionId: "prompts-promoted", title: "Promoted chip on its own", group: "prompts" },
  { sectionId: "prompts-dismissed", title: "After a dismissal", group: "prompts" },
  {
    sectionId: "prompts-contextual-waiting-run",
    title: "Contextual — run waiting in a queue",
    group: "prompts",
  },
  {
    sectionId: "prompts-contextual-slow-run",
    title: "Contextual — run slower than usual",
    group: "prompts",
  },
  {
    sectionId: "prompts-contextual-saturation",
    title: "Contextual — queue at capacity",
    group: "prompts",
  },
  { sectionId: "prompts-page-runs", title: "Page defaults — runs list", group: "prompts" },
  { sectionId: "prompts-page-error", title: "Page defaults — error group", group: "prompts" },
  {
    sectionId: "prompts-page-deployment",
    title: "Page defaults — deployment",
    group: "prompts",
  },

  // --- Intent bubbles ------------------------------------------------------
  {
    sectionId: "intent-navigate-filtered-runs",
    title: "Navigate — runs with filters",
    group: "intents",
  },
  { sectionId: "intent-navigate-run", title: "Navigate — one run", group: "intents" },
  { sectionId: "intent-watch", title: "Watch started", group: "intents" },
  { sectionId: "intent-ask", title: "Ask — follow-up handed back", group: "intents" },
  {
    sectionId: "intent-rejected-propose-fix",
    title: "Rejected — propose_fix is reserved",
    group: "intents",
  },

  // --- Message-level states, through the production renderer ---------------
  {
    sectionId: "messages-streaming-text",
    title: "Text part still streaming, with activity row",
    group: "messages",
  },
  { sectionId: "messages-reasoning", title: "Reasoning part", group: "messages" },
  { sectionId: "messages-tool-in-flight", title: "Tool call in flight", group: "messages" },
  {
    sectionId: "messages-tool-expanded",
    title: "Tool call expanded on its output",
    group: "messages",
    expandText: "output",
  },
  {
    sectionId: "messages-error-retry",
    title: "Failed turn — error row and retry",
    group: "messages",
  },
  {
    sectionId: "messages-render-view",
    title: "render_view part — blocks as cards",
    group: "messages",
  },
  { sectionId: "messages-docs-sources", title: "Answer with source links", group: "messages" },
];

/** Sections in a group, in manifest order. */
export function sectionsInGroup(group: GalleryGroup): GallerySection[] {
  return MANIFEST.filter((section) => section.group === group);
}
