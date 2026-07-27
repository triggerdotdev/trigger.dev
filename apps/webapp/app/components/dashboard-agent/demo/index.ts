/**
 * Dashboard agent demo mode — the public surface.
 *
 * Demo mode is a set of canned conversations ("fixtures") rendered by the real
 * panel components with no transport, no LLM and no writes, so the v1 flows can
 * be reviewed as UI before their backends exist.
 *
 * Wiring it into the panel is meant to be a small diff. Everything the panel
 * needs is here:
 *
 * ```tsx
 * // history: append the demo rows when demo mode is on
 * setChats([...(data.chats ?? []), ...(demoEnabled ? demoHistoryChats : [])]);
 *
 * // active chat: a demo id renders the fixture view instead of the transport
 * ) : active && isDemoChatId(active.chatId) ? (
 *   <DemoChatView
 *     chatId={active.chatId}
 *     projectSlug={project.slug}
 *     environmentSlug={environment.slug}
 *     currentPage={currentPage}
 *   />
 * ) : active ? (
 *   <DashboardAgentChat … />
 * ```
 *
 * `openChat` must also skip its fetch for a demo id (there is nothing stored) —
 * `isDemoChatId` is the only test needed for that.
 *
 * `isDashboardAgentDemoEnabled()` lives in `./demoFlag.server` and is imported
 * directly by the loader that resolves the flag; it is deliberately NOT
 * re-exported here, because this module must stay free of server imports.
 */
export {
  demoChatById,
  demoChats,
  demoEmptyHistoryChats,
  demoHistoryChats,
  type DemoChat,
  type DemoFlow,
  type DemoItem,
} from "./demo-chats";
export { DemoChatView } from "./DemoChatView";
export { DEMO_ID_PREFIX, DEMO_MARKER, DEMO_WORLD, demoId, isDemoChatId } from "./ids";

// The fixtures themselves, so a storybook page (or a later test) can render one
// card at a time without going through a conversation.
export * as demoFixtures from "./fixtures";

// The demo-only cards, for the same reason.
export { DemoChartCard } from "./components/DemoChartCard";
export { DemoIntentBubble, DemoNote } from "./components/DemoIntentBubble";
export { DemoInvestigationCard } from "./components/DemoInvestigationCard";
export { DemoReportCard } from "./components/DemoReportCard";
export { DemoSuggestedPromptsRow } from "./components/DemoSuggestedPromptsRow";
export { DemoWatchChips } from "./components/DemoWatchChips";
