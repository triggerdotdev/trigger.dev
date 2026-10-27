import { useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
import { alertChannelsResourcePath } from "~/components/alerts/alertChannelsResourcePath";
import { CREATE_ALERT_PATH, queryAlertRequestBody } from "~/components/alerts/createAlertRequest";
import {
  defaultQueryWindowMinutes,
  queryAlertNameKey,
  queryConditionModes,
  querySignalOptions,
  queryWindowBounds,
  type QueryAlertMode,
  type QueryAlertPrefill,
} from "~/components/alerts/queryAlertLink";
import type { QueryPreviewOutcome } from "~/components/alerts/QueryPreviewResult";
import { allSteps, applyStepSelection } from "~/components/alerts/wizardSteps";
import { useCreationFlowState } from "~/components/dashboard-agent/alert-creation";
import type { AlertChannel } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3EnvironmentPath } from "~/utils/pathBuilder";
import type { PreviewQueryResponse } from "~/v3/services/alerts/previewQuery.server";

export type QueryAlertChat = {
  chatId: string;
  ensure: () => Promise<{ chatId: string; release?: () => void } | undefined>;
};

const PREVIEW_FAILED = "Preview failed. Try again.";
const CHAT_FAILED = "We couldn't set up this chat to receive the alert. Try again.";
const CREATE_FAILED = "Failed to create the alert. Try again.";

export function useQueryAlertDraft(
  prefill: QueryAlertPrefill,
  onCreated: (alertId: string | undefined, chatId?: string) => void,
  chat?: QueryAlertChat
) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { analysis, query } = prefill;

  const signals = querySignalOptions(analysis);
  const [signalId, setSignalId] = useState(
    () =>
      signals.find((s) =>
        prefill.mode === "match"
          ? s.mode === "match"
          : s.mode === "threshold" && s.measure === prefill.measure
      )?.id ?? signals[0]!.id
  );
  const signal = signals.find((s) => s.id === signalId) ?? signals[0]!;
  const modes = queryConditionModes(analysis, signal);
  const [modeChoice, setModeChoice] = useState<QueryAlertMode | undefined>(prefill.mode);
  const mode = modeChoice && modes.includes(modeChoice) ? modeChoice : modes[0]!;
  const measure = mode === "match" ? undefined : signal.measure;

  const [operator, setOperator] = useState<">" | "<">(prefill.operator ?? ">");
  const [valueText, setValueText] = useState(() =>
    typeof prefill.value === "number" && Number.isFinite(prefill.value) ? String(prefill.value) : ""
  );
  const value = valueText.trim() === "" ? undefined : Number(valueText);
  const valueValid = mode !== "threshold" || (value !== undefined && Number.isFinite(value));

  const bounds = queryWindowBounds(analysis.limits);
  const defaultWindow = defaultQueryWindowMinutes(prefill.period, analysis.limits);
  const [windowText, setWindowText] = useState(() => {
    const windowSec = prefill.windowSec;
    if (typeof windowSec !== "number" || !Number.isFinite(windowSec)) return String(defaultWindow);
    return String(Math.min(bounds.max, Math.max(bounds.min, Math.ceil(windowSec / 60))));
  });
  const windowMinutes = mode === "match" ? defaultWindow : Number(windowText);
  const windowValid =
    mode === "match" ||
    (Number.isInteger(windowMinutes) && windowMinutes >= bounds.min && windowMinutes <= bounds.max);

  const suggestedName = prefill.names[queryAlertNameKey(mode, measure)] ?? analysis.suggestedName;
  const [editedName, setEditedName] = useState<string>();
  const name = editedName ?? suggestedName;

  const flow = useCreationFlowState(undefined, { notifiers: chat ? ["chat"] : [] });
  const [addingChannel, setAddingChannel] = useState(false);
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
  const addChannel = {
    projectId: project.id,
    environmentId: environment.id,
    canWrite: channelsFetcher.data?.canWrite ?? false,
    atLimit: limits ? limits.used >= limits.limit : false,
    onCreated: () => channelsFetcher.load(channelsPath),
  };
  const channels = channelsFetcher.data?.channels ?? [];
  const steps = allSteps(flow, channels, chat?.chatId, addChannel);
  const expiryStep = steps.find((step) => step.id === "expiry")!;
  const notifiersStep = steps.find((step) => step.id === "notifiers")!;
  const hasNotifier = notifiersStep.options.some(
    (option) => !option.disabledReason && flow.answers.notifiers?.includes(option.id)
  );
  const selectStep = (stepId: string, optionId: string) =>
    applyStepSelection(flow, stepId, optionId, {
      onShowAll: () => {},
      onAddChannel: () => setAddingChannel(true),
    });

  const previewBody = {
    query,
    mode,
    measure,
    windowMinutes,
    threshold: mode === "threshold" ? value : undefined,
    operator: mode === "threshold" ? operator : undefined,
  };
  const previewKey = JSON.stringify(previewBody);
  const [preview, setPreview] = useState<{ key: string; outcome: QueryPreviewOutcome }>();
  const [previewing, setPreviewing] = useState(false);
  const canPreview = windowValid && valueValid;

  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const canCreate =
    canPreview && hasNotifier && flow.answers.expiry !== undefined && name.trim() !== "";

  async function runPreview() {
    setPreviewing(true);
    let outcome: QueryPreviewOutcome;
    try {
      const resp = await fetch(
        `/resources${v3EnvironmentPath(organization, project, environment)}/alerts/preview-query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: previewKey,
        }
      );
      outcome =
        resp.status === 429
          ? { kind: "busy" }
          : resp.ok
            ? { kind: "result", response: (await resp.json()) as PreviewQueryResponse }
            : { kind: "error", message: PREVIEW_FAILED };
    } catch {
      outcome = { kind: "error", message: PREVIEW_FAILED };
    }
    setPreview({ key: previewKey, outcome });
    setPreviewing(false);
  }

  async function create() {
    setSubmitting(true);
    setCreateError(undefined);
    let session: Awaited<ReturnType<QueryAlertChat["ensure"]>>;
    try {
      session = await chat?.ensure();
      if (chat && !session && flow.answers.notifiers?.includes("chat")) {
        setCreateError(CHAT_FAILED);
        setSubmitting(false);
        return;
      }
      const resp = await fetch(CREATE_ALERT_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          queryAlertRequestBody(
            {
              organizationId: organization.id,
              projectId: project.id,
              environmentId: environment.id,
            },
            {
              query,
              name: name.trim(),
              mode,
              measure,
              operator,
              value,
              windowMinutes,
              expiry: flow.answers.expiry,
              notifiers: flow.answers.notifiers ?? [],
            },
            session && { chatId: session.chatId, transcriptChatId: session.chatId }
          )
        ),
      });
      const data = (await resp.json().catch(() => ({}))) as { alertId?: string; error?: string };
      if (!resp.ok) {
        setCreateError(
          (resp.status === 400 || resp.status === 422) && data.error ? data.error : CREATE_FAILED
        );
        setSubmitting(false);
        session?.release?.();
        return;
      }
      if (session) onCreated(data.alertId, session.chatId);
      else onCreated(data.alertId);
    } catch {
      session?.release?.();
      setCreateError(CREATE_FAILED);
      setSubmitting(false);
    }
  }

  return {
    analysis,
    query,
    signals,
    signal,
    setSignalId,
    modes,
    mode,
    setModeChoice,
    measure,
    operator,
    setOperator,
    valueText,
    setValueText,
    value,
    valueValid,
    bounds,
    windowText,
    setWindowText,
    windowMinutes,
    windowValid,
    name,
    setEditedName,
    flow,
    channels,
    addChannel,
    addingChannel,
    setAddingChannel,
    expiryStep,
    notifiersStep,
    hasNotifier,
    selectStep,
    preview: preview && preview.key === previewKey ? preview.outcome : undefined,
    previewing,
    canPreview,
    runPreview,
    submitting,
    createError,
    canCreate,
    create,
  };
}
