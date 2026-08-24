// Keep this file free of imports and JSX so plain node can read it.

export type GalleryPageId = "chat" | "view-blocks" | "report" | "investigation" | "watch";

export type GalleryPage = {
  id: GalleryPageId;
  slug: string;
  title: string;
  blurb: string;
};

export const GALLERY_PAGES: GalleryPage[] = [
  {
    id: "chat",
    slug: "agent-ui",
    title: "Chat UI",
    blurb:
      "The chat chrome: the blank-state hero, suggested prompts, the transcript and its one progress line, wake banners, watch chips and the context banner.",
  },
  {
    id: "view-blocks",
    slug: "agent-view-blocks",
    title: "View blocks",
    blurb:
      "The envelope rules every card obeys, the diagnosis card, the actions block and the chart card.",
  },
  {
    id: "report",
    slug: "agent-report",
    title: "Report view",
    blurb: "The health report, one state per verdict it can reach.",
  },
  {
    id: "investigation",
    slug: "agent-investigation",
    title: "Investigation card",
    blurb: "One card per ending an investigation can have, plus the state while it is still going.",
  },
  {
    id: "watch",
    slug: "agent-watch",
    title: "Watch card",
    blurb:
      "The configuration card, what a submitted card leaves in the transcript, and the wake headline.",
  },
];

export type GalleryGroup =
  | "card"
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
  /** DOM id and deep-link anchor. Renaming breaks the link. */
  sectionId: string;
  title: string;
  group: GalleryGroup;
};

export const GALLERY_GROUPS: { group: GalleryGroup; page: GalleryPageId; label: string }[] = [
  { group: "hero", page: "chat", label: "Blank-state hero" },
  { group: "prompts", page: "chat", label: "Suggested prompts" },
  { group: "messages", page: "chat", label: "Message-level states" },
  { group: "intents", page: "chat", label: "Intent bubbles" },
  { group: "wakes", page: "chat", label: "Wake banners" },
  { group: "watches", page: "chat", label: "Watch chips" },
  { group: "banner", page: "chat", label: "Context banner" },
  { group: "view-blocks", page: "view-blocks", label: "Envelope & actions" },
  { group: "card", page: "view-blocks", label: "Card chrome" },
  { group: "diagnosis", page: "view-blocks", label: "Diagnosis card" },
  { group: "chart", page: "view-blocks", label: "Chart card" },
  { group: "report", page: "report", label: "Report view" },
  { group: "investigation", page: "investigation", label: "Investigation card" },
  { group: "watch-card", page: "watch", label: "Watch card" },
];

export const MANIFEST: GallerySection[] = [
  { sectionId: "hero-panel", title: "Side panel (380px) — no page context", group: "hero" },
  {
    sectionId: "hero-panel-contextual",
    title: "Side panel — failed run on the page",
    group: "hero",
  },
  { sectionId: "hero-fullscreen", title: "Fullscreen takeover — centred column", group: "hero" },
  { sectionId: "hero-in-chat", title: "Empty chat — hero without its own composer", group: "hero" },

  { sectionId: "prompts-default", title: "Default set, no page context", group: "prompts" },
  {
    sectionId: "prompts-contextual-fresh-failure",
    title: "Contextual — fresh failure first",
    group: "prompts",
  },
  { sectionId: "prompts-promoted", title: "Promoted chip on top", group: "prompts" },
  { sectionId: "prompts-dismissed", title: "After a dismissal", group: "prompts" },

  {
    sectionId: "messages-streaming-text",
    title: "Text part still streaming, with activity row",
    group: "messages",
  },
  { sectionId: "messages-reasoning", title: "Reasoning part", group: "messages" },
  {
    sectionId: "messages-tool-in-flight",
    title: "Tool call in flight — the turn's one progress line",
    group: "messages",
  },
  {
    sectionId: "messages-tool-pending-pills",
    title: "Progress labels — one per tool, including a card tool",
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
  {
    sectionId: "messages-investigation-live",
    title: "Live investigation — the card, and the turn's one progress line under it",
    group: "messages",
  },
  { sectionId: "messages-docs-sources", title: "Answer with source links", group: "messages" },

  {
    sectionId: "intent-navigate-filtered-runs",
    title: "Navigate — runs with filters",
    group: "intents",
  },
  { sectionId: "intent-watch", title: "Watch started", group: "intents" },
  {
    sectionId: "intent-rejected-propose-fix",
    title: "Rejected — propose_fix is reserved",
    group: "intents",
  },

  { sectionId: "wake-positive", title: "Positive", group: "wakes" },
  { sectionId: "wake-attention", title: "Attention", group: "wakes" },
  { sectionId: "wake-neutral-impossible", title: "Neutral — no longer possible", group: "wakes" },
  { sectionId: "wake-unverified", title: "Unverified at the window's end", group: "wakes" },

  { sectionId: "watches-live", title: "All four states, cancellable", group: "watches" },

  { sectionId: "banner-prod", title: "Production environment", group: "banner" },
  { sectionId: "banner-preview-long", title: "Preview branch with a long name", group: "banner" },

  {
    sectionId: "view-blocks-revisions",
    title: "Three same-id revisions collapse to one card",
    group: "view-blocks",
  },
  {
    sectionId: "view-blocks-mixed",
    title: "Enveloped revisions plus a legacy block with no envelope",
    group: "view-blocks",
  },
  {
    sectionId: "view-blocks-actions-offer",
    title: "Actions block — the watch offer as buttons",
    group: "view-blocks",
  },

  { sectionId: "card-compact", title: "Header plus a compact body", group: "card" },
  { sectionId: "card-roomy", title: "Header plus a roomy body", group: "card" },
  { sectionId: "card-headerless", title: "No header — body only", group: "card" },

  { sectionId: "diagnosis-full-high", title: "Full card, high confidence", group: "diagnosis" },
  {
    sectionId: "diagnosis-low-minimal",
    title: "Low confidence, minimal evidence",
    group: "diagnosis",
  },
  {
    sectionId: "diagnosis-badge-matrix",
    title: "Badge matrix — every category x confidence",
    group: "diagnosis",
  },

  {
    sectionId: "chart-with-actions",
    title: "Ranking chart with actions on the top item",
    group: "chart",
  },
  { sectionId: "chart-empty", title: "Empty — no data to display", group: "chart" },

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

  {
    sectionId: "investigation-card-streaming-rev1",
    title: "In progress — one hypothesis settled",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-concluded",
    title: "Concluded, collapsed",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-concluded-code-grounded",
    title: "Concluded, code-grounded — source citation and Show code",
    group: "investigation",
  },
  {
    sectionId: "investigation-card-concluded-not-code-grounded",
    title: "Concluded, not code-grounded — no source citation, no Show code",
    group: "investigation",
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

  { sectionId: "watch-card-compact", title: "Compact — the recommendation", group: "watch-card" },
  { sectionId: "watch-card-expanded", title: "Expanded (Customize)", group: "watch-card" },
  { sectionId: "watch-card-validation-error", title: "Validation error", group: "watch-card" },
  { sectionId: "watch-card-pending", title: "Pending create", group: "watch-card" },
  {
    sectionId: "watch-card-queue-below",
    title: "Customize — back below a threshold",
    group: "watch-card",
  },
  {
    sectionId: "watch-card-queue-stalled",
    title: "Customize — stopped moving (no parameter)",
    group: "watch-card",
  },
  {
    sectionId: "watch-card-confirmation",
    title: "Confirmation block — both opt-ins took effect",
    group: "watch-card",
  },
  {
    sectionId: "watch-card-confirmation-degraded",
    title: "Confirmation block — first check and email both unavailable",
    group: "watch-card",
  },
  {
    sectionId: "watch-card-one-shot-satisfied",
    title: "One-shot result — already true",
    group: "watch-card",
  },
  {
    sectionId: "watch-card-toast-headline",
    title: "Wake toast headline (fact first)",
    group: "watch-card",
  },
];

export function groupsOnPage(page: GalleryPageId) {
  return GALLERY_GROUPS.filter((entry) => entry.page === page);
}

export function sectionsInGroup(group: GalleryGroup): GallerySection[] {
  return MANIFEST.filter((section) => section.group === group);
}

export function sectionsOnPage(page: GalleryPageId): GallerySection[] {
  return groupsOnPage(page).flatMap((entry) => sectionsInGroup(entry.group));
}
