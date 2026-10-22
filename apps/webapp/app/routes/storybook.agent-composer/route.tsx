import type { AgentPageContext } from "@internal/dashboard-agent-contracts";
import { useState } from "react";
import {
  AgentQuotaNoticeView,
  AgentUpgradeBlockView,
} from "~/components/dashboard-agent/AgentUpgradeGate";
import {
  ChatProgress,
  ChatText,
  ChatTranscript,
  ChatTurn,
} from "~/components/dashboard-agent/chat-layout";
import {
  DashboardAgentComposer,
  NewChatButton,
} from "~/components/dashboard-agent/DashboardAgentComposer";
import { DashboardAgentContextBanner } from "~/components/dashboard-agent/DashboardAgentContextBanner";
import { DashboardAgentDraft } from "~/components/dashboard-agent/DashboardAgentDraft";
import { DashboardAgentHero } from "~/components/dashboard-agent/DashboardAgentHero";
import { demoFixtures } from "~/components/dashboard-agent/demo";
import {
  MAX_MESSAGE_CHARS,
  MESSAGE_CHARS_WARN_AT,
} from "~/components/dashboard-agent/message-limits";
import {
  FREE_PLAN_MESSAGE_LIMIT,
  MESSAGE_QUOTA_REACHED_REASON,
} from "~/components/dashboard-agent/message-quota";
import {
  AGENT_PANEL_MAX_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  AgentPanelColumn,
  FLOATING_HEIGHT,
  FLOATING_WIDTH,
} from "~/components/dashboard-agent/panel-layout";
import { watchDraftFor } from "~/components/dashboard-agent/watch-card";
import { WatchCard } from "~/components/dashboard-agent/WatchCard";
import { queueWatchRecommendation } from "~/components/dashboard-agent/watch-recommendations";
import { cn } from "~/utils/cn";
import { GalleryPage, noop, PANEL_FRAME } from "../storybook.agent-ui/gallery";

const { demoPageContexts } = demoFixtures;

const PROJECT = "Demo Storefront";
const RUN_ID = "run_a1b2c3d4e5f6";
// Anything that can't navigate: deep links need an organization the gallery doesn't have.
const UPGRADE_PATH = "#upgrade";

const SHORT_DRAFT = "Why did this run fail, and will the retry fix it?";

const LONG_DRAFT = `The nightly backfill failed again on the same step. This is the error from the last attempt:

ProviderError: 429 Too Many Requests (rate_limit_exceeded)
    at sendEmail (src/trigger/emails/sendOrderReceipt.ts:42:11)
    at async withRetry (src/trigger/lib/retry.ts:27:14)
    at async run (src/trigger/emails/sendOrderReceipt.ts:18:5)
    at async TaskExecutor.execute (node_modules/@trigger.dev/core/dist/v3/workers/taskExecutor.js:211:22)
    at async ZodIpcConnection.handler (node_modules/@trigger.dev/core/dist/v3/zodIpc.js:84:28)
    at async process.<anonymous> (node_modules/@trigger.dev/core/dist/v3/zodIpc.js:156:13)

It only happens when more than about 200 receipts go out at once. Before that the same task runs cleanly for weeks.

Things I've already tried:
- raising retry.maxAttempts from 3 to 5
- adding a 1s delay between batches
- moving the task onto its own queue

None of that changed anything. Is this the retry settings, or do we need a queue-level rate limit? And if it's the queue, what concurrency would keep us under the provider's limit?`;

const LOG_LINE =
  "2026-10-17T14:02:11.418Z WARN [send-order-receipt] attempt 3/3 failed: ProviderError 429 rate_limit_exceeded\n";

/** A pasted log, cut to an exact length. */
function pastedLog(length: number) {
  return LOG_LINE.repeat(Math.ceil(length / LOG_LINE.length)).slice(0, length);
}

function ContextBanner({
  environmentSlug = "prod",
  entityId = RUN_ID,
}: {
  environmentSlug?: string;
  entityId?: string;
}) {
  return (
    <DashboardAgentContextBanner
      projectName={PROJECT}
      environmentSlug={environmentSlug}
      entityId={entityId}
    />
  );
}

function ProposedWatchCard() {
  const [draft, setDraft] = useState(() => watchDraftFor(queueWatchRecommendation("email-sends")));
  return <WatchCard draft={draft} onChange={setDraft} onSubmit={noop} onCancel={noop} />;
}

/** The end of a conversation, so a docked composer sits where it does in a real chat. */
function TranscriptTail({ inFlight = false }: { inFlight?: boolean }) {
  return (
    <ChatTranscript>
      <ChatTurn speaker="user">
        <ChatText speaker="user" text={`Why did ${RUN_ID} fail?`} />
      </ChatTurn>
      <ChatTurn>
        {inFlight ? (
          <ChatProgress>Reading the run…</ChatProgress>
        ) : (
          <ChatText
            text={`All three attempts of \`${RUN_ID}\` hit the email provider's rate limit inside the same 20 seconds, so the retries never had a chance to clear it.`}
          />
        )}
      </ChatTurn>
    </ChatTranscript>
  );
}

/** Mirrors the bottom of `DashboardAgentChat` once a conversation has started. */
function DockedComposer({
  initialValue = "",
  isStreaming = false,
  context = <ContextBanner />,
  quotaRemaining,
  capReached,
  watchCard = false,
  width,
  height = 384,
  fullscreen = false,
}: {
  initialValue?: string;
  isStreaming?: boolean;
  context?: React.ReactNode;
  /** Free plan, under the cap: the messages left show under the composer. */
  quotaRemaining?: number;
  /** Swaps the composer for the upgrade block, as `atMessageCap` does. */
  capReached?: { limit: number; planResolved: boolean };
  watchCard?: boolean;
  width?: number;
  height?: number;
  fullscreen?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className={cn(PANEL_FRAME, "flex flex-col overflow-hidden")} style={{ width, height }}>
      <AgentPanelColumn fullscreen={fullscreen}>
        <TranscriptTail inFlight={isStreaming} />
        {watchCard ? (
          <div className="px-3 pb-2">
            <ProposedWatchCard />
          </div>
        ) : null}
        {capReached ? (
          <AgentUpgradeBlockView
            limit={capReached.limit}
            planResolved={capReached.planResolved}
            context={context}
            upgradePath={UPGRADE_PATH}
          />
        ) : (
          <DashboardAgentComposer
            autoFocus={false}
            value={value}
            onChange={setValue}
            onSubmit={() => setValue("")}
            onStop={noop}
            isStreaming={isStreaming}
            context={context}
            trailingAction={<NewChatButton onClick={() => setValue("")} />}
            notice={
              quotaRemaining === undefined ? undefined : (
                <AgentQuotaNoticeView
                  remaining={quotaRemaining}
                  limit={FREE_PLAN_MESSAGE_LIMIT}
                  upgradePath={UPGRADE_PATH}
                />
              )
            }
          />
        )}
      </AgentPanelColumn>
    </div>
  );
}

const HERO_FRAME = cn(PANEL_FRAME, "flex h-[32rem] flex-col");

/** The real new-chat draft, with the page's suggested prompts under it. */
function NewChatHero({
  pageContext,
  watchCard = false,
  fullscreen = false,
}: {
  pageContext: AgentPageContext;
  watchCard?: boolean;
  fullscreen?: boolean;
}) {
  return (
    <div className={cn(HERO_FRAME, fullscreen && "w-[60rem]")}>
      <AgentPanelColumn fullscreen={fullscreen}>
        <DashboardAgentDraft
          onSubmit={noop}
          projectName={PROJECT}
          environmentSlug="prod"
          entityId={RUN_ID}
          pageContext={pageContext}
          watchCard={watchCard ? <ProposedWatchCard /> : undefined}
          autoFocus={false}
        />
      </AgentPanelColumn>
    </div>
  );
}

/** Mirrors `DashboardAgentChat`'s hero, for a chat that exists but has no messages yet. */
function EmptyChatHero({ initialValue = "" }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className={HERO_FRAME}>
      <AgentPanelColumn fullscreen={false}>
        <DashboardAgentHero
          onSelect={noop}
          pageContext={demoPageContexts.failedRun}
          dismissedIds={[]}
          composer={
            <DashboardAgentComposer
              layout="hero"
              autoFocus={false}
              value={value}
              onChange={setValue}
              onSubmit={() => setValue("")}
              onStop={noop}
              isStreaming={false}
              context={<ContextBanner />}
            />
          }
        />
      </AgentPanelColumn>
    </div>
  );
}

/** Mirrors `DashboardAgentDraft` over the cap: the chips disable and the block takes the slot. */
function CappedNewChatHero() {
  return (
    <div className={HERO_FRAME}>
      <AgentPanelColumn fullscreen={false}>
        <DashboardAgentHero
          onSelect={noop}
          pageContext={demoPageContexts.failedRun}
          dismissedIds={[]}
          promptsDisabledReason={MESSAGE_QUOTA_REACHED_REASON}
          composer={
            <div className="flex w-full flex-col gap-3">
              <AgentUpgradeBlockView
                limit={50}
                planResolved
                context={<ContextBanner />}
                upgradePath={UPGRADE_PATH}
              />
            </div>
          }
        />
      </AgentPanelColumn>
    </div>
  );
}

/* `data-theme` scopes the whole token set, so each column renders in its own theme
   whatever the storybook header is set to. */
const THEMES = [
  { theme: "light", label: "Light" },
  { theme: "white", label: "White" },
  { theme: "dark", label: "Dark" },
  { theme: "black", label: "Black" },
] as const;

function ThemeColumns() {
  return (
    <div className="grid grid-cols-[repeat(2,max-content)] gap-4">
      {THEMES.map(({ theme, label }) => (
        <div
          key={theme}
          data-theme={theme}
          className="space-y-2 rounded-lg border border-grid-bright bg-background-deep p-4"
        >
          <p className="text-xxs uppercase tracking-wide text-text-dimmed">{label}</p>
          <DockedComposer
            initialValue={SHORT_DRAFT}
            quotaRemaining={3}
            width={FLOATING_WIDTH}
            height={300}
          />
        </div>
      ))}
    </div>
  );
}

const STATES: Record<string, React.ReactNode> = {
  "composer-docked-empty": <DockedComposer />,
  "composer-docked-draft": <DockedComposer initialValue={SHORT_DRAFT} />,
  "composer-docked-long-draft": (
    <DockedComposer initialValue={LONG_DRAFT} height={FLOATING_HEIGHT} />
  ),
  "composer-docked-streaming": <DockedComposer isStreaming />,
  "composer-docked-list-context": (
    <DockedComposer
      context={<DashboardAgentContextBanner projectName={PROJECT} environmentSlug="prod" />}
    />
  ),
  "composer-docked-long-context": (
    <DockedComposer
      context={
        <ContextBanner
          environmentSlug="preview-demo-feature-rework-receipt-email-batching"
          entityId="20240101.1"
        />
      }
    />
  ),
  "composer-docked-watch-card": <DockedComposer watchCard height={FLOATING_HEIGHT} />,

  "composer-hero-new-chat": <NewChatHero pageContext={demoPageContexts.failedRun} />,
  "composer-hero-draft": <EmptyChatHero initialValue={SHORT_DRAFT} />,
  "composer-hero-watch-card": <NewChatHero pageContext={demoPageContexts.queue} watchCard />,
  "composer-hero-fullscreen": <NewChatHero pageContext={demoPageContexts.runs} fullscreen />,

  "composer-limit-near": (
    <DockedComposer
      initialValue={pastedLog(MESSAGE_CHARS_WARN_AT + 240)}
      height={FLOATING_HEIGHT}
    />
  ),
  "composer-limit-reached": (
    <DockedComposer initialValue={pastedLog(MAX_MESSAGE_CHARS)} height={FLOATING_HEIGHT} />
  ),
  "composer-quota-left": <DockedComposer initialValue={SHORT_DRAFT} quotaRemaining={3} />,
  "composer-cap-docked": (
    <DockedComposer capReached={{ limit: FREE_PLAN_MESSAGE_LIMIT, planResolved: false }} />
  ),
  "composer-cap-hero": <CappedNewChatHero />,

  "composer-mode-right-panel-narrow": (
    <DockedComposer initialValue={SHORT_DRAFT} quotaRemaining={3} width={AGENT_PANEL_MIN_WIDTH} />
  ),
  "composer-mode-right-panel-wide": (
    <DockedComposer initialValue={SHORT_DRAFT} quotaRemaining={3} width={AGENT_PANEL_MAX_WIDTH} />
  ),
  "composer-mode-fullscreen": (
    <DockedComposer initialValue={SHORT_DRAFT} quotaRemaining={3} width={960} fullscreen />
  ),

  "composer-themes": <ThemeColumns />,
};

export default function Story() {
  return (
    <GalleryPage
      page="composer"
      states={STATES}
      componentNames={[
        "DashboardAgentComposer.tsx",
        "AgentAiDisclosure.tsx",
        "AgentUpgradeGate.tsx",
        "DashboardAgentContextBanner.tsx",
        "panel-layout.tsx",
      ]}
    />
  );
}
