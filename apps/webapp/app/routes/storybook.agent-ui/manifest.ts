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
  | "watch-card"
  | "wakes"
  | "hero"
  | "prompts"
  | "intents"
  | "messages"
  | "banner";

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
  { group: "watch-card", label: "Watch card" },
  { group: "wakes", label: "Wake banners" },
  { group: "hero", label: "Blank-state hero" },
  { group: "prompts", label: "Suggested prompts" },
  { group: "intents", label: "Intent bubbles" },
  { group: "messages", label: "Message-level states" },
  { group: "banner", label: "Context banner" },
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

  // --- Investigation card ---------------------------------------------------
  // The shipped `InvestigationCard` (fed the real block) first, then the demo
  // mockup whose review froze the payload — kept so the two can be compared.
  {
    sectionId: "investigation-card-in-progress-early",
    title: "In progress, early — subject and first evidence, no hypotheses",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-streaming-rev0",
    title: "Streaming, revision 0 — nothing settled",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-streaming-rev1",
    title: "Streaming, revision 1 — one hypothesis settled",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-concluded",
    title: "Concluded, collapsed",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-concluded-expanded",
    title: "Concluded, details expanded",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-concluded-code-grounded",
    title: "Concluded, code-grounded — source citation and Show code",
    group: "investigation",
    expandText: "How I worked this out",
  },
  {
    sectionId: "investigation-card-concluded-not-code-grounded",
    title: "Concluded, not code-grounded — no source citation, no Show code",
    group: "investigation",
    expandText: "How I worked this out",
  },
  {
    sectionId: "investigation-card-inconclusive",
    title: "Inconclusive — no fix, what to check next",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-degraded",
    title: "Inconclusive, degraded after a tool failure — names what it couldn't read",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-dirty-commit",
    title: "Dirty-commit caveat",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-revisions",
    title: "Two revisions of one investigation collapse to one card",
    group: "investigation",
  },
  {
    sectionId: "investigation-streaming-rev0",
    title: "Demo mockup — streaming, revision 0",
    group: "investigation",
  },
  {
    sectionId: "investigation-streaming-rev1",
    title: "Demo mockup — streaming, revision 1",
    group: "investigation",
  },
  {
    sectionId: "investigation-concluded",
    title: "Demo mockup — concluded, collapsed",
    group: "investigation",
  },
  {
    sectionId: "investigation-concluded-expanded",
    title: "Demo mockup — concluded, expanded",
    group: "investigation",
  },
  {
    sectionId: "investigation-inconclusive",
    title: "Demo mockup — inconclusive",
    group: "investigation",
  },
  {
    sectionId: "investigation-dirty-commit",
    title: "Demo mockup — dirty-commit caveat",
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
  {
    sectionId: "chart-with-actions",
    title: "Ranking chart with actions on the top item",
    group: "chart",
  },
  { sectionId: "chart-empty", title: "Empty — no data to display", group: "chart" },

  // --- Watch chips ---------------------------------------------------------
  { sectionId: "watches-active", title: "Active — cancellable", group: "watches" },
  { sectionId: "watches-fired", title: "Fired", group: "watches" },
  { sectionId: "watches-expired", title: "Expired", group: "watches" },
  { sectionId: "watches-cancelled", title: "Cancelled", group: "watches" },
  { sectionId: "watches-all-states", title: "All four states in one row", group: "watches" },
  { sectionId: "watches-live", title: "The panel's own chips (real component)", group: "watches" },

  // --- Watch card ----------------------------------------------------------
  // The configuration card and the two blocks a submitted card leaves behind.
  // The card is ephemeral (it never enters the transcript), so the states here
  // are the whole of what a user can see of it.
  {
    sectionId: "watch-card-compact",
    title: "Compact — the recommendation",
    group: "watch-card",
  },
  { sectionId: "watch-card-expanded", title: "Expanded (Customize)", group: "watch-card" },
  { sectionId: "watch-card-validation-error", title: "Validation error", group: "watch-card" },
  { sectionId: "watch-card-pending", title: "Pending create", group: "watch-card" },
  { sectionId: "watch-card-create-failure", title: "Create failure", group: "watch-card" },
  { sectionId: "watch-card-confirmation", title: "Confirmation block", group: "watch-card" },
  {
    sectionId: "watch-card-one-shot-satisfied",
    title: "One-shot result — already true",
    group: "watch-card",
  },
  {
    sectionId: "watch-card-one-shot-impossible",
    title: "One-shot result — can't happen now",
    group: "watch-card",
  },
  {
    sectionId: "watch-card-toast-headline",
    title: "Wake toast headline (fact first)",
    group: "watch-card",
  },

  // --- Wake banners --------------------------------------------------------
  // A wake narration through the production renderer: the banner plus the prose
  // the agent wrote, as the panel shows them.
  { sectionId: "wake-positive", title: "Positive", group: "wakes" },
  { sectionId: "wake-attention", title: "Attention", group: "wakes" },
  {
    sectionId: "wake-attention-failed-run",
    title: "Attention — a run that finished badly",
    group: "wakes",
  },
  { sectionId: "wake-window-completed", title: "Window completed", group: "wakes" },
  { sectionId: "wake-neutral-impossible", title: "Neutral — no longer possible", group: "wakes" },
  { sectionId: "wake-unverified", title: "Unverified at the window's end", group: "wakes" },
  {
    sectionId: "wake-unknown-watch",
    title: "Fired, watch not in hand — kind-agnostic",
    group: "wakes",
  },

  // --- Blank-state hero -----------------------------------------------------
  // The new-chat state, with the composer inside the hero. Both widths it ships
  // at: the 380px side panel and the fullscreen takeover's centred column.
  {
    sectionId: "hero-panel",
    title: "Side panel (380px) — no page context",
    group: "hero",
  },
  {
    sectionId: "hero-panel-contextual",
    title: "Side panel — failed run on the page",
    group: "hero",
  },
  {
    sectionId: "hero-panel-promoted",
    title: "Side panel — with a promoted prompt",
    group: "hero",
  },
  {
    sectionId: "hero-fullscreen",
    title: "Fullscreen takeover — centred column",
    group: "hero",
  },
  {
    sectionId: "hero-in-chat",
    title: "Empty chat — hero without its own composer",
    group: "hero",
  },

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
  {
    sectionId: "messages-tool-in-flight",
    title: "Tool call in flight — pending pill",
    group: "messages",
  },
  {
    sectionId: "messages-tool-pending-pills",
    title: "Pending pills — the labels, including a card tool",
    group: "messages",
  },
  {
    sectionId: "messages-tool-completed",
    title: "Completed tool call — no row, just the answer",
    group: "messages",
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
  { sectionId: "banner-prod", title: "Production environment", group: "banner" },
  { sectionId: "banner-dev", title: "Dev environment", group: "banner" },
  { sectionId: "banner-preview-long", title: "Preview branch with a long name", group: "banner" },
  { sectionId: "banner-run-detail", title: "Run detail page", group: "banner" },
];

/** Sections in a group, in manifest order. */
export function sectionsInGroup(group: GalleryGroup): GallerySection[] {
  return MANIFEST.filter((section) => section.group === group);
}
