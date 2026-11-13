import { useFetcher, useNavigate } from "@remix-run/react";
import { useEffect, useState } from "react";
import { alertChannelsResourcePath } from "~/components/alerts/alertChannelsResourcePath";
import { AlertChannelsDialog } from "~/components/alerts/AlertChannelsDialog";
import { AgentManualToggle, NewChatButton } from "~/components/alerts/creationControls";
import {
  GROUP_ALERTS_PATH,
  defaultGroupName,
  groupAlertsBody,
  type GroupMode,
} from "~/components/alerts/groupAlertsRequest";
import {
  allSteps,
  applyStepSelection,
  NO_NOTIFIER,
  type AddChannelAccess,
} from "~/components/alerts/wizardSteps";
import { useCreationFlowState } from "~/components/dashboard-agent/alert-creation";
import type { AlertChannel } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  CUSTOM_EXPIRY,
  alertName,
  promptForStep,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { ManualStep } from "~/components/dashboard-agent/alert-creation/ManualCreationForm";
import { ChatText, ChatTranscript, ChatTurn } from "~/components/dashboard-agent/chat-layout";
import { ChatWizardCard, type ChatWizardStep } from "~/components/dashboard-agent/ChatWizardCard";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { SegmentedToggle } from "~/components/primitives/SegmentedToggle";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { permissionDeniedMessage } from "~/utils/permissionDenied";

const MODE_OPTIONS = [
  { id: "any", label: "Raise when any" },
  { id: "all", label: "Raise when all" },
];

const CREATE_FAILED = "Could not create the group. Try again.";

const STEP_ORDER = ["mode", "notifiers", "expiry", "name"];

type Member = { id: string; name: string };

type ResolveChat = () => Promise<{ chatId?: string; release?: () => void }>;

type GroupCreated = (created: { chatId?: string; message?: unknown }) => void;

function useGroupDraft({
  members,
  channels,
  addChannel,
  onCreated,
  resolveChatId,
}: {
  members: Member[];
  channels: AlertChannel[];
  addChannel?: AddChannelAccess;
  onCreated?: GroupCreated;
  resolveChatId?: ResolveChat;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [mode, setMode] = useState<GroupMode>("any");
  const [addingChannel, setAddingChannel] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const flow = useCreationFlowState(undefined, {
    notifiers: [],
    name: defaultGroupName(members.length),
  });
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const footnote = `Groups ${members.map((m) => m.name).join(", ")}. Their own notifications pause while grouped.`;
  const baseSteps = allSteps(flow, channels, addChannel);
  const notifiersStep = baseSteps.find((step) => step.id === "notifiers")!;
  const expiryStep = baseSteps.find((step) => step.id === "expiry")!;
  const hasNotifier = notifiersStep.options.some(
    (option) => !option.disabledReason && flow.answers.notifiers?.includes(option.id)
  );
  const name = alertName(flow.answers);
  const canCreate =
    hasNotifier &&
    flow.answers.expiry !== undefined &&
    flow.answers.name?.trim() !== "" &&
    name.trim() !== "" &&
    !submitting;
  const overrides: Record<string, Partial<ChatWizardStep>> = {
    notifiers: { confirmDisabled: !hasNotifier, error: hasNotifier ? undefined : NO_NOTIFIER },
    name: { description: footnote, confirmLabel: "Create group", confirmDisabled: !canCreate },
  };
  const steps: ChatWizardStep[] = STEP_ORDER.map((id) =>
    id === "mode"
      ? {
          id,
          question: promptForStep("condition", {}),
          description: footnote,
          options: MODE_OPTIONS,
          selected: [mode],
          allowSkip: false,
        }
      : { ...baseSteps.find((step) => step.id === id)!, ...overrides[id] }
  );

  const select = (stepId: string, optionId: string) => {
    if (stepId === "mode") {
      setMode(optionId as GroupMode);
      setStepIndex(1);
      return;
    }
    applyStepSelection(flow, stepId, optionId, {
      onShowAll: () => {},
      onAddChannel: () => setAddingChannel(true),
    });
    if (stepId === "expiry" && optionId !== CUSTOM_EXPIRY) setStepIndex(3);
  };

  const create = async () => {
    setSubmitting(true);
    setError(undefined);
    let release: (() => void) | undefined;
    try {
      const resolved = await resolveChatId?.();
      const chatId = resolved?.chatId;
      release = resolved?.release;
      const resp = await fetch(GROUP_ALERTS_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          groupAlertsBody(
            {
              organizationId: organization.id,
              projectId: project.id,
              environmentId: environment.id,
            },
            {
              memberAlertIds: members.map((m) => m.id),
              compositeMode: mode,
              name: name.trim(),
              notifiers: flow.answers.notifiers ?? [],
              expiry: flow.answers.expiry,
            },
            chatId
          )
        ),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: unknown;
        path?: string;
      };
      if (resp.ok && data.ok) {
        onCreated?.({ chatId, message: data.message });
        if (!(chatId && data.message)) {
          release?.();
          if (data.path) navigate(data.path);
        }
        return;
      }
      setError(data.error ?? permissionDeniedMessage(data) ?? CREATE_FAILED);
    } catch {
      setError(CREATE_FAILED);
    }
    release?.();
    setSubmitting(false);
  };

  return {
    mode,
    setMode,
    flow,
    name,
    steps,
    notifiersStep,
    expiryStep,
    hasNotifier,
    stepIndex,
    setStepIndex,
    select,
    create,
    canCreate,
    error,
    addingChannel,
    closeAddChannel: () => {
      setAddingChannel(false);
      addChannel?.onCreated?.();
    },
  };
}

type GroupDraft = ReturnType<typeof useGroupDraft>;

function AddChannelDialog({ draft }: { draft: GroupDraft }) {
  return draft.addingChannel ? (
    <AlertChannelsDialog
      open
      onCreated={(channel) => {
        if (!draft.flow.answers.notifiers?.includes(channel.id)) {
          draft.flow.toggleNotifier(channel.id);
        }
      }}
      onClose={draft.closeAddChannel}
    />
  ) : null;
}

function GroupManualForm({ draft }: { draft: GroupDraft }) {
  return (
    <div data-testid="group-manual-form" className="flex flex-col gap-4">
      <SegmentedToggle
        segments={MODE_OPTIONS.map((o) => ({
          value: o.id as GroupMode,
          label: o.label,
          icon: null,
        }))}
        value={draft.mode}
        onChange={draft.setMode}
        ariaLabel="When should this alert fire?"
      />
      <ManualStep
        step={{ ...draft.notifiersStep, error: draft.hasNotifier ? undefined : NO_NOTIFIER }}
        onSelect={draft.select}
      />
      <ManualStep step={draft.expiryStep} onSelect={draft.select} />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="pb-1.5 text-sm text-text-bright">Name</legend>
        <Input
          variant="small"
          aria-label="Name"
          value={draft.name}
          onChange={(e) => draft.flow.setName(e.target.value)}
        />
      </fieldset>
      {draft.error ? <Callout variant="error">{draft.error}</Callout> : null}
      <div className="flex justify-end">
        <Button variant="primary/small" disabled={!draft.canCreate} onClick={draft.create}>
          Create group
        </Button>
      </div>
    </div>
  );
}

export function GroupAlertsTranscript({
  members,
  channels,
  addChannel,
  manual,
  onManualChange,
  onNewChat,
  onCreated,
  resolveChatId,
}: {
  members: Member[];
  channels: AlertChannel[];
  addChannel?: AddChannelAccess;
  onCreated?: GroupCreated;
  resolveChatId?: ResolveChat;
  manual: boolean;
  onManualChange: (manual: boolean) => void;
  onNewChat?: () => void;
}) {
  const draft = useGroupDraft({ members, channels, addChannel, onCreated, resolveChatId });
  const [closed, setClosed] = useState(false);

  const modeRow = (
    <div
      className="flex min-w-0 items-center justify-between gap-2 bg-background-bright px-3 pb-3 pt-1.5"
      data-testid="manual-mode-toggle"
    >
      <AgentManualToggle manual={manual} onChange={onManualChange} />
      {onNewChat && <NewChatButton onClick={onNewChat} />}
    </div>
  );

  if (manual) {
    return (
      <>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <GroupManualForm draft={draft} />
        </div>
        <AddChannelDialog draft={draft} />
        <div className="relative shrink-0">{modeRow}</div>
      </>
    );
  }

  return (
    <>
      <ChatTranscript>
        <div data-testid="group-flow" className="flex flex-col gap-3">
          <ChatTurn speaker="user">
            <ChatText speaker="user" text={`Group ${members.length} alerts`} />
          </ChatTurn>
          {closed ? (
            <ChatTurn speaker="assistant">
              <Button variant="secondary/small" onClick={() => setClosed(false)}>
                Continue
              </Button>
            </ChatTurn>
          ) : null}
          {draft.error ? (
            <ChatTurn speaker="assistant">
              <Callout variant="error">{draft.error}</Callout>
            </ChatTurn>
          ) : null}
        </div>
      </ChatTranscript>
      <AddChannelDialog draft={draft} />
      <div className="relative shrink-0">
        {closed ? null : (
          <div className="absolute inset-x-3 bottom-full z-10 mb-1">
            <ChatWizardCard
              steps={draft.steps}
              stepIndex={draft.stepIndex}
              onStepChange={draft.setStepIndex}
              onSelect={draft.select}
              onSkip={() => {}}
              onClose={() => setClosed(true)}
              onConfirm={(id) =>
                id === "name" ? draft.create() : draft.setStepIndex(STEP_ORDER.indexOf(id) + 1)
              }
            />
          </div>
        )}
        {modeRow}
      </div>
    </>
  );
}

export function GroupAlertsDialog({
  members,
  onClose,
}: {
  members: Member[];
  onClose: () => void;
}) {
  const project = useProject();
  const environment = useEnvironment();
  const channelsFetcher = useFetcher<{
    channels: AlertChannel[];
    canWrite?: boolean;
    limits?: { used: number; limit: number };
  }>();
  const channelsPath = alertChannelsResourcePath(project.id, false, environment.id);
  useEffect(() => {
    channelsFetcher.load(channelsPath);
  }, [channelsPath]); // eslint-disable-line react-hooks/exhaustive-deps -- fetcher is stable
  const limits = channelsFetcher.data?.limits;
  const draft = useGroupDraft({
    members,
    channels: channelsFetcher.data?.channels ?? [],
    onCreated: onClose,
    addChannel: {
      projectId: project.id,
      environmentId: environment.id,
      canWrite: channelsFetcher.data?.canWrite ?? false,
      atLimit: limits ? limits.used >= limits.limit : false,
      onCreated: () => channelsFetcher.load(channelsPath),
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>Group {members.length} alerts</DialogHeader>
        <div className="mt-3">
          <GroupManualForm draft={draft} />
        </div>
        <AddChannelDialog draft={draft} />
      </DialogContent>
    </Dialog>
  );
}
