/**
 * Dashboard agent design fixtures — the public surface.
 *
 * A set of canned conversations and card payloads rendered by the real panel
 * components with no transport, no LLM and no writes, so every v1 state can be
 * reviewed as UI. The state gallery (`/storybook/agent-ui`) is the consumer.
 *
 * The panel itself never renders any of this: its example conversations are real
 * stored chats, seeded by `pnpm --filter webapp run db:seed:agent-examples`.
 *
 * This module must stay free of server imports — the isolation test in
 * `demo.test.ts` asserts that.
 */
export { demoChatById, demoChats, type DemoChat, type DemoFlow, type DemoItem } from "./demo-chats";
export { DEMO_ID_PREFIX, DEMO_MARKER, DEMO_WORLD, demoId } from "./ids";

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
