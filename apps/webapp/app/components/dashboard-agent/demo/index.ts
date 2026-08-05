/**
 * Dashboard agent design fixtures: canned conversations and card payloads rendered
 * by the real panel components with no transport, no LLM and no writes. The state
 * gallery (`/storybook/agent-ui`) is the consumer; the panel itself only ever
 * renders real stored chats.
 *
 * This module must stay free of server imports. `demo.test.ts` asserts that.
 */
export { demoChatById, demoChats, type DemoChat, type DemoFlow, type DemoItem } from "./demo-chats";
export { DEMO_ID_PREFIX, DEMO_MARKER, DEMO_WORLD, demoId } from "./ids";

// Fixtures and cards, so a page can render one card without a conversation.
export * as demoFixtures from "./fixtures";

export { DemoChartCard } from "./components/DemoChartCard";
export { DemoIntentBubble, DemoNote } from "./components/DemoIntentBubble";
export { DemoInvestigationCard } from "./components/DemoInvestigationCard";
export { DemoSuggestedPromptsRow } from "./components/DemoSuggestedPromptsRow";
export { DemoWatchChips } from "./components/DemoWatchChips";
