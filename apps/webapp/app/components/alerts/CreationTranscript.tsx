import { useEffect, useRef, useState } from "react";
import { AlertChannelsDialog } from "~/components/alerts/AlertChannelsDialog";
import type { ErrorGroupOption, ResolveErrorGroup } from "~/components/alerts/errorGroupOptions";
import { saveSlackConnectResume } from "~/components/alerts/slackConnectResume";
import { useErrorGroupLookup } from "~/components/alerts/useErrorGroupLookup";
import {
  AreaAvailabilityLoader,
  ScopeEntitiesLoader,
  type AreaAvailability,
  type ScopeEntities,
} from "~/components/alerts/ScopeEntitiesLoader";
import {
  scopeEntityKind,
  scopeEntityKindFor,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import {
  ChatProgress,
  ChatText,
  ChatTranscript,
  ChatTurn,
} from "~/components/dashboard-agent/chat-layout";
import { liveProgress } from "~/components/dashboard-agent/progress-line";
import { ChatWizardCard } from "~/components/dashboard-agent/ChatWizardCard";
import { ManualCreationForm } from "~/components/dashboard-agent/alert-creation/ManualCreationForm";
import { CreationComposer } from "~/components/alerts/CreationComposer";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { cn } from "~/utils/cn";
import { WatchStyleReviewCard, AlertCreatedCard } from "~/components/alerts/creationCards";
import { AgentManualToggle, NewChatButton } from "~/components/alerts/creationControls";
import {
  ALERT_CREATION_OPENING_TEXT,
  REVIEW_MESSAGE,
  shownCreatedBlock,
} from "~/components/alerts/alertCreatedCard";
import type {
  CreationFlowState,
  AlertChannel,
} from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  allSteps,
  applyStepSelection,
  buildCreatedFields,
  buildReviewFields,
  CARD_GAP,
  cardPosition,
  CHAT_CHIP,
  confirmStep,
  CONTINUE_OPTION,
  NO_NOTIFIER,
  scenarioStep,
  SHOW_ALL_CHIP,
  type AddChannelAccess,
} from "~/components/alerts/wizardSteps";

export type { CreationFlowState, AlertChannel };
export type { AddChannelAccess };

export type SystemLine = {
  id: string;
  text: string;
  variant: "info" | "error" | "user" | "reply";
};

export function CreationTranscript({
  flow,
  channels = [],
  chatId,
  alertDetailPath,
  onFreeText,
  systemLines = [],
  agentStreaming = false,
  manual = false,
  onManualChange,
  onNewChat,
  manualBody,
  density = "compact",
  addChannel,
  errorGroupSource,
  queueMetricsEnabled = true,
  environmentTitle,
}: {
  flow: CreationFlowState;
  channels?: AlertChannel[];
  chatId?: string;
  alertDetailPath?: (alertId: string) => string;
  onFreeText?: (text: string) => void;
  systemLines?: SystemLine[];
  agentStreaming?: boolean;
  manual?: boolean;
  onManualChange?: (manual: boolean) => void;
  onNewChat?: () => void;
  manualBody?: React.ReactNode;
  density?: "compact" | "full";
  addChannel?: AddChannelAccess;
  errorGroupSource?: { groups: ErrorGroupOption[] | undefined; resolve: ResolveErrorGroup };
  queueMetricsEnabled?: boolean;
  environmentTitle?: string;
}) {
  const [composerValue, setComposerValue] = useState("");
  const [cardClosed, setCardClosed] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const lastLine = systemLines[systemLines.length - 1];
  const [seenLine, setSeenLine] = useState(lastLine);
  if (seenLine !== lastLine) {
    setSeenLine(lastLine);
    if (lastLine && lastLine.variant !== "user") setAwaitingReply(false);
  }
  const [seenStreaming, setSeenStreaming] = useState(agentStreaming);
  if (seenStreaming !== agentStreaming) {
    setSeenStreaming(agentStreaming);
    if (seenStreaming) setAwaitingReply(false);
  }
  const waiting = awaitingReply || agentStreaming;
  const [view, setView] = useState<{ flowIndex: number; index: number }>();
  const [cardHeight, setCardHeight] = useState(0);
  const [scenarios, setScenarios] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [customIndex, setCustomIndex] = useState(0);
  const chatDefaulted = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [roomHeight, setRoomHeight] = useState(0);
  const [addingChannel, setAddingChannel] = useState(false);
  const resumed = addChannel?.resumed ?? false;
  const allChannels = channels;
  const reviewFields = buildReviewFields(flow, allChannels, environmentTitle);
  const createdBlock = shownCreatedBlock(
    flow,
    buildCreatedFields(flow, allChannels, environmentTitle)
  );

  const { lookup, lookupError } = useErrorGroupLookup(flow, errorGroupSource?.resolve);
  const errorGroups = { groups: errorGroupSource?.groups, lookup, lookupError };
  const entityKind = flow.answers.replace ? undefined : scopeEntityKindFor(flow.answers);
  const [entities, setEntities] = useState<ScopeEntities>();
  const [entitySearch, setEntitySearch] = useState("");
  const scopeEntities = entities?.kind === entityKind ? entities?.names : undefined;
  const [availability, setAvailability] = useState<AreaAvailability>();
  const hiddenAreas = queueMetricsEnabled ? [] : ["queues"];
  const emptyAreas = availability?.empty ?? [];
  const availabilityLoader = !flow.answers.area && (
    <AreaAvailabilityLoader loaded={availability} onLoad={setAvailability} />
  );
  const position = cardPosition(flow);
  const cardSteps = position
    ? allSteps(
        flow,
        allChannels,
        chatId,
        addChannel,
        errorGroups,
        scopeEntities,
        emptyAreas,
        setEntitySearch,
        hiddenAreas
      )
    : [];
  const flowIndex = Math.max(
    0,
    cardSteps.findIndex((step) => step.id === position)
  );
  const viewIndex = view && view.flowIndex === flowIndex ? view.index : flowIndex;
  const loadKind =
    scopeEntityKind(flow.answers.scope) ??
    (cardSteps[viewIndex]?.id === "scope" ? entityKind : undefined);
  const hasNotifier = (flow.answers.notifiers ?? []).some(
    (id) => (id === CHAT_CHIP.value && Boolean(chatId)) || allChannels.some((ch) => ch.id === id)
  );
  const editing = customizing && flow.isReview;
  const customSteps = editing
    ? allSteps(
        flow,
        allChannels,
        chatId,
        addChannel,
        errorGroups,
        scopeEntities,
        emptyAreas,
        setEntitySearch,
        hiddenAreas
      )
    : [];
  const cardOpen = editing || (Boolean(position) && !cardClosed);
  const scenarioOpen = scenarios && (editing || Boolean(position));

  const needsChatDefault =
    flow.currentStep === "notifiers" &&
    Boolean(chatId) &&
    !flow.answers.replace &&
    !flow.answers.notifiers?.length;
  const { toggleNotifier } = flow;
  useEffect(() => {
    if (!needsChatDefault || chatDefaulted.current) return;
    chatDefaulted.current = true;
    toggleNotifier("chat");
  }, [needsChatDefault, toggleNotifier]);

  function startOver() {
    setCustomizing(false);
    setCardClosed(false);
    setScenarios(false);
    setView(undefined);
    chatDefaulted.current = false;
    (onNewChat ?? flow.reset)();
  }

  function selectCustomOption(stepId: string, value: string) {
    const index = customSteps.findIndex((step) => step.id === stepId);
    const step = customSteps[index];
    if (stepId === "scenarios" || value === SHOW_ALL_CHIP.value) {
      if (stepId === "scenarios") setCustomizing(false);
      selectCardOption(stepId, value);
      return;
    }
    if (step?.multiSelect) {
      selectCardOption(stepId, value);
      return;
    }
    if (step?.selected?.includes(value)) {
      setCustomIndex(Math.min(index + 1, customSteps.length - 1));
      return;
    }
    selectCardOption(stepId, value);
    if (stepId === "condition" || stepId === "expiry") setCustomIndex(index + 1);
    else setCustomizing(false);
  }

  useEffect(() => {
    const el = cardRef.current;
    if (!cardOpen || !el || typeof ResizeObserver === "undefined") {
      setCardHeight(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) => setCardHeight(entry?.contentRect.height ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, [cardOpen]);

  useEffect(() => {
    const viewport = transcriptRef.current?.parentElement;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setRoomHeight(entry?.contentRect.height ?? 0));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  function selectCardOption(stepId: string, value: string) {
    if (stepId === "scenarios") setScenarios(false);
    const step = cardSteps.find((s) => s.id === stepId);
    if (!step?.multiSelect && step?.selected?.includes(value) && value !== CONTINUE_OPTION) {
      setView(undefined);
      return;
    }
    applyStepSelection(flow, stepId, value, {
      onShowAll: () => setScenarios(true),
      onAddChannel: () => setAddingChannel(true),
    });
    if (!step?.multiSelect) setView(undefined);
  }

  function closeCard() {
    setScenarios(false);
    setCustomizing(false);
    setCardClosed(true);
  }

  function handleComposerSubmit() {
    const text = composerValue.trim();
    if (!text || waiting) return;
    closeCard();
    setAwaitingReply(true);
    onFreeText?.(text);
    setComposerValue("");
  }

  const showModeRow = Boolean(onManualChange) && (manual || Boolean(onFreeText));
  const modeRow = showModeRow ? (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-2 bg-background-bright px-3 pb-3",
        manual ? "pt-1" : "pt-1.5"
      )}
      data-testid="manual-mode-toggle"
    >
      <AgentManualToggle manual={manual} onChange={onManualChange!} />
      {onNewChat && <NewChatButton onClick={onNewChat} />}
    </div>
  ) : null;

  if (manual) {
    return (
      <>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {manualBody ?? (
            <ManualCreationForm
              flow={flow}
              channels={channels}
              chatId={chatId}
              addChannel={addChannel}
              emptyAreas={emptyAreas}
              hiddenAreas={hiddenAreas}
              onStartOver={startOver}
              environmentTitle={environmentTitle}
              alertDetailPath={
                flow.createdAlertId && alertDetailPath
                  ? alertDetailPath(flow.createdAlertId)
                  : undefined
              }
            />
          )}
          {availabilityLoader}
        </div>
        {null}
        <div className="relative shrink-0">
          {null}
          {null}
          {modeRow}
        </div>
      </>
    );
  }

  return (
    <>
      <ChatTranscript contentRef={transcriptRef}>
        <div data-testid="creation-flow" data-density={density} className="flex flex-col gap-3">
          <ChatTurn speaker="user">
            <ChatText speaker="user" text={ALERT_CREATION_OPENING_TEXT} />
          </ChatTurn>
          {systemLines.map((line) => {
            const speaker = line.variant === "user" ? "user" : "assistant";
            return (
              <ChatTurn key={line.id} speaker={speaker}>
                <div
                  data-testid={`system-line-${line.variant}`}
                  className={speaker === "user" ? "flex w-full justify-end" : undefined}
                >
                  <ChatText speaker={speaker} text={line.text} />
                </div>
              </ChatTurn>
            );
          })}
          {waiting && (
            <ChatTurn>
              <ChatProgress>{liveProgress([], "thinking")?.label}</ChatProgress>
            </ChatTurn>
          )}
          {position && cardClosed && !waiting && (
            <ChatTurn speaker="assistant">
              <Button
                variant="secondary/small"
                onClick={() => {
                  setView(undefined);
                  setCardClosed(false);
                }}
              >
                Continue setup
              </Button>
            </ChatTurn>
          )}

          {((flow.isReview && reviewFields && !editing) || (flow.created && createdBlock)) && (
            <ChatTurn speaker="assistant">
              <ChatText speaker="assistant" text={REVIEW_MESSAGE} />
              {flow.created && createdBlock ? (
                <AlertCreatedCard
                  block={createdBlock}
                  alertDetailPath={
                    flow.createdAlertId && alertDetailPath
                      ? alertDetailPath(flow.createdAlertId)
                      : undefined
                  }
                />
              ) : reviewFields ? (
                <WatchStyleReviewCard
                  fields={reviewFields}
                  actions={{
                    onCreate: flow.create,
                    onCustomize: () => {
                      setCustomizing(true);
                      setCustomIndex(hasNotifier ? 0 : Number.MAX_SAFE_INTEGER);
                    },
                    blockedReason: hasNotifier ? undefined : NO_NOTIFIER,
                    onStartOver: startOver,
                    submitting: flow.submitting,
                  }}
                />
              ) : null}
              {flow.submitError && (
                <Callout variant="error">Failed to create the alert. Try again.</Callout>
              )}
            </ChatTurn>
          )}
          {cardOpen && cardHeight > 0 && (
            <div data-testid="card-spacer" aria-hidden style={{ height: cardHeight }} />
          )}
          {availabilityLoader}
          {loadKind && (
            <ScopeEntitiesLoader
              kind={loadKind}
              current={flow.answers.scopeValue}
              search={entitySearch}
              onLoad={setEntities}
            />
          )}
        </div>
      </ChatTranscript>

      {addChannel && (addingChannel || resumed) && (
        <AlertChannelsDialog
          open
          connectReturnTo={addChannel.connectReturnTo}
          addSlack={resumed}
          onConnect={() =>
            saveSlackConnectResume(addChannel.projectId, addChannel.environmentId, flow.answers)
          }
          onCreated={(channel) => {
            if (!flow.answers.notifiers?.includes(channel.id)) flow.toggleNotifier(channel.id);
          }}
          onClose={() => {
            setAddingChannel(false);
            addChannel.onResumeConsumed?.();
            addChannel.onCreated?.();
          }}
        />
      )}
      <div className="relative shrink-0">
        {cardOpen && (editing || position) && (
          <div ref={cardRef} className="absolute inset-x-3 bottom-full z-10 mb-1">
            <ChatWizardCard
              key={scenarioOpen ? "scenarios" : editing ? "customize" : "flow"}
              steps={
                scenarioOpen
                  ? [scenarioStep(hiddenAreas, emptyAreas)]
                  : editing
                    ? customSteps
                    : cardSteps
              }
              stepIndex={
                scenarioOpen
                  ? 0
                  : editing
                    ? Math.min(customIndex, customSteps.length - 1)
                    : viewIndex
              }
              onStepChange={(index) => {
                if (editing) setCustomIndex(index);
                else setView({ flowIndex, index });
              }}
              onSelect={editing ? selectCustomOption : selectCardOption}
              onSkip={() => {}}
              onClose={() => {
                if (scenarioOpen) setScenarios(false);
                else if (editing) setCustomizing(false);
                else setCardClosed(true);
              }}
              onConfirm={(stepId) => {
                confirmStep(flow, stepId);
                setCustomizing(false);
              }}
              maxHeight={roomHeight > CARD_GAP ? roomHeight - CARD_GAP : undefined}
            />
          </div>
        )}
        {onFreeText && (
          <div className={showModeRow ? "[&>div]:pb-0" : undefined}>
            <CreationComposer
              value={composerValue}
              onChange={setComposerValue}
              onSubmit={handleComposerSubmit}
              onStop={() => {}}
              isStreaming={agentStreaming}
              trailingAction={!showModeRow && onNewChat && <NewChatButton onClick={onNewChat} />}
            />
          </div>
        )}
        {modeRow}
      </div>
    </>
  );
}
