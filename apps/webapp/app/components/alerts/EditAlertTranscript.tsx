import { useFetcher } from "@remix-run/react";
import { useState } from "react";
import { AlertChannelsDialog } from "~/components/alerts/AlertChannelsDialog";
import { AlertUpdatedCard } from "~/components/alerts/creationCards";
import { NewChatButton } from "~/components/alerts/creationControls";
import type { AddChannelAccess } from "~/components/alerts/CreationTranscript";
import type { AlertChannel } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  CUSTOM_EXPIRY,
  EXPIRY_CHIPS,
  expiryDate,
  expiryFromDate,
  promptForStep,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { ChatText, ChatTranscript, ChatTurn } from "~/components/dashboard-agent/chat-layout";
import { ChatWizardCard, type ChatWizardStep } from "~/components/dashboard-agent/ChatWizardCard";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";

export type EditAlertPrefill = {
  alertId: string;
  name: string;
  conditionSummary: string;
  scopeSummary?: string;
  notifiers: { key: string; label?: string }[];
  expiresAt?: string | null;
  /** Inactive alert: review expiry and notifiers, then save activates it. */
  activate?: boolean;
};

const ADD_CHANNEL_OPTION = "__add_channel__";
const NO_NOTIFIER = "Pick at least one destination.";
const NO_EXPIRY = "Pick how long it should stay active.";

/** A past expiry stays unanswered so it has to be picked again. */
function initialExpiry(expiresAt: string | null | undefined): string | undefined {
  if (!expiresAt) return "none";
  return expiryFromDate(new Date(expiresAt));
}

function channelKey(id: string) {
  return `channel:${id}`;
}

type NotifierOption = { id: string; label: string; disabledReason?: string; locked?: boolean };

function notifierOptions(
  prefill: EditAlertPrefill,
  channels: AlertChannel[],
  userId: string
): NotifierOption[] {
  const chats = prefill.notifiers
    .filter((n) => n.key.startsWith("chat:"))
    .map((n): NotifierOption => {
      const owner = n.key.split(":")[2];
      if (owner === userId) return { id: n.key, label: n.label ?? "This chat" };
      if (owner === "-") return { id: n.key, label: "Project chat" };
      return {
        id: n.key,
        label: "Another member's chat",
        disabledReason: "Kept as is; only its owner can change it",
        locked: true,
      };
    });
  const live = channels.map((ch) => ({ id: channelKey(ch.id), label: ch.name || ch.type }));
  return [...chats, ...live];
}

export function EditAlertTranscript({
  prefill,
  channels,
  alertPath,
  addChannel,
  userId,
  onNewChat,
}: {
  prefill: EditAlertPrefill;
  channels: AlertChannel[];
  alertPath: string;
  addChannel?: AddChannelAccess;
  userId: string;
  onNewChat?: () => void;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [selected, setSelected] = useState(() => prefill.notifiers.map((n) => n.key));
  const [closed, setClosed] = useState(false);
  const [addingChannel, setAddingChannel] = useState(false);
  const activate = prefill.activate === true;
  const [expiry, setExpiry] = useState(() => initialExpiry(prefill.expiresAt));
  const [stepIndex, setStepIndex] = useState(0);

  const allChannels = channels;
  const options = notifierOptions(prefill, allChannels, userId);
  const locked = options.filter((o) => o.locked).map((o) => o.id);
  const chosen = selected.filter((key) => options.some((o) => o.id === key && !o.disabledReason));
  const picked = [...locked, ...chosen];
  const initial = prefill.notifiers
    .map((n) => n.key)
    .filter((key) => !locked.includes(key))
    .sort()
    .join(",");
  const changed = [...chosen].sort().join(",") !== initial;
  const updated = fetcher.data?.ok === true;
  const submitting = fetcher.state !== "idle";

  const presetExpiry = EXPIRY_CHIPS.some((chip) => chip.value === expiry);
  const expiryStep: ChatWizardStep = {
    id: "expiry",
    question: "How long should it stay active?",
    options: EXPIRY_CHIPS.map((chip) => ({ id: chip.value, label: chip.label })),
    selected: expiry ? [presetExpiry ? expiry : CUSTOM_EXPIRY] : [],
    customOption: CUSTOM_EXPIRY,
    onReveal: () => setExpiry(undefined),
    custom: {
      id: "expiry",
      type: "date",
      current: presetExpiry ? undefined : expiry,
      ariaLabel: "Expires at",
      parse: (text) => expiryFromDate(new Date(text)),
      onSubmit: (value) => {
        setExpiry(value);
        setStepIndex(1);
      },
    },
  };

  const steps: ChatWizardStep[] = [
    expiryStep,
    {
      id: "notifiers",
      question: promptForStep("notifiers", {}),
      options: addChannel
        ? [
            ...options,
            {
              id: ADD_CHANNEL_OPTION,
              label: "Add channel",
              cardLabel: "Add channel…",
              trailingIcon: null,
              disabledReason: !addChannel.canWrite
                ? "You don't have permission to add channels"
                : addChannel.atLimit
                  ? "This project is at its channel limit"
                  : undefined,
            },
          ]
        : options,
      multiSelect: true,
      selected: picked,
      error: !picked.length ? NO_NOTIFIER : !expiry ? NO_EXPIRY : undefined,
      allowSkip: false,
      confirmDisabled: !expiry,
      ...(activate
        ? {
            confirmLabel: "Activate",
            hint: "Watching resumes from now",
          }
        : {}),
    },
  ];

  function toggle(key: string) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function select(stepId: string, value: string) {
    if (stepId === "expiry") {
      if (value === CUSTOM_EXPIRY) return;
      setExpiry(value);
      setStepIndex(1);
    } else if (value === ADD_CHANNEL_OPTION) {
      setAddingChannel(true);
    } else {
      toggle(value);
    }
  }

  function save() {
    if (submitting || !picked.length || !expiry) return;
    const expiresAt = expiry === "none" ? "none" : (expiryDate(expiry)?.toISOString() ?? "");
    fetcher.submit(
      activate
        ? { intent: "activate", respond: "json", notifierIds: picked.join(","), expiresAt }
        : {
            intent: "edit",
            respond: "json",
            ...(changed ? { notifierIds: picked.join(",") } : {}),
            expiresAt,
          },
      { method: "post", action: alertPath }
    );
  }

  const notifyLabel = options
    .filter((o) => picked.includes(o.id))
    .map((o) => o.label)
    .join(", ");

  return (
    <>
      <ChatTranscript>
        <div data-testid="edit-flow" className="flex flex-col gap-3">
          <ChatTurn speaker="user">
            <ChatText speaker="user" text={`${activate ? "Activate" : "Edit"} ${prefill.name}`} />
          </ChatTurn>
          {closed && !updated && (
            <ChatTurn speaker="assistant">
              <Button variant="secondary/small" onClick={() => setClosed(false)}>
                Continue editing
              </Button>
            </ChatTurn>
          )}
          {fetcher.data?.error && !updated && (
            <ChatTurn speaker="assistant">
              <Callout variant="error">{fetcher.data.error}</Callout>
            </ChatTurn>
          )}
          {updated && (
            <ChatTurn speaker="assistant">
              <ChatText speaker="assistant" text={activate ? "Activated." : "Updated."} />
              <AlertUpdatedCard
                fields={{
                  name: prefill.name,
                  conditionSummary: prefill.conditionSummary,
                  scopeSummary: prefill.scopeSummary,
                  behavior: "recurring",
                  notifyLabel,
                }}
                alertDetailPath={alertPath}
              />
            </ChatTurn>
          )}
        </div>
      </ChatTranscript>
      {addChannel && addingChannel && (
        <AlertChannelsDialog
          open
          onCreated={(channel) => setSelected((prev) => [...prev, channelKey(channel.id)])}
          onClose={() => {
            setAddingChannel(false);
            addChannel.onCreated?.();
          }}
        />
      )}
      <div className="relative shrink-0">
        {!closed && !updated && (
          <div className="absolute inset-x-3 bottom-full z-10 mb-1">
            <ChatWizardCard
              steps={steps}
              stepIndex={Math.min(stepIndex, steps.length - 1)}
              onStepChange={setStepIndex}
              onSelect={select}
              onSkip={() => {}}
              onClose={() => setClosed(true)}
              onConfirm={save}
            />
          </div>
        )}
        {onNewChat && (
          <div className="flex items-center justify-end px-3 pb-3 pt-1">
            <NewChatButton onClick={onNewChat} />
          </div>
        )}
      </div>
    </>
  );
}
