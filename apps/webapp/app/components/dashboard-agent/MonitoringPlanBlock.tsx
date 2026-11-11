import type { UIMessage } from "@ai-sdk/react";
import {
  parseMonitoringPlan,
  type MonitoringPlan,
  type MonitoringPlanItem,
  type PlanDecisionOutput,
} from "@internal/dashboard-agent-contracts";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  CREATE_ALERT_PATH,
  createAlertErrorMessage,
  createAlertRequestBody,
  queryAlertRequestBody,
} from "~/components/alerts/createAlertRequest";
import {
  defaultGroupName,
  GROUP_ALERTS_PATH,
  groupAlertsBody,
} from "~/components/alerts/groupAlertsRequest";
import { splitPlanItemKeys, type AlertCreatedMessage } from "~/components/alerts/alertCreatedCard";
import { AlertCreatedCard } from "~/components/alerts/creationCards";
import { QueryBlock } from "~/components/alerts/QueryBlock";
import { AlertChannelsDialog } from "~/components/alerts/AlertChannelsDialog";
import {
  useQueryAlertWizard,
  useQueryAnalysis,
  type QueryWatchPrefill,
} from "~/components/alerts/QueryAlertTranscript";
import { ScopeEntitiesLoader, type ScopeEntities } from "~/components/alerts/ScopeEntitiesLoader";
import { UNUSABLE_QUERY, type QueryAlertPrefill } from "~/components/alerts/queryAlertLink";
import { useQueryAlertDraft, type QueryAlertChat } from "~/components/alerts/useQueryAlertDraft";
import {
  ADD_CHANNEL_OPTION,
  allSteps,
  applyStepSelection,
  confirmStep,
  nameStep,
  notifiersStep,
  type AddChannelAccess,
} from "~/components/alerts/wizardSteps";
import { Button } from "~/components/primitives/Buttons";
import { useEnvironment, useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useCreationFlowState } from "./alert-creation";
import type { AlertChannel } from "./alert-creation/CreationFlow";
import {
  applyDraftPatch,
  queryWatchFromPatch,
  type AlertDraftPatch,
} from "./alert-creation/draftPatch";
import {
  alertName,
  capabilityParams,
  draftMissing,
  needsScopeValue,
  requiredParams,
  resolveCapability,
  scopeEntityKindFor,
  withAutoAnswers,
  type FlowAnswers,
} from "./alert-creation/flow-state";
import { ChatActionsRow, ChatCardSlot, ChatText } from "./chat-layout";
import { ChatWizardCard, type ChatWizardStep } from "./ChatWizardCard";
import { useWizardMaxHeight } from "./useWizardMaxHeight";
import {
  createdAlertKey,
  planItemKey,
  type MonitoringPlanState,
  type PlanFlow,
  type PlanItemRef,
  type PlanItemStatus,
} from "./useMonitoringPlanState";

export type MonitoringPlanHost = MonitoringPlanState & {
  chatId?: string;
  channels?: AlertChannel[];
  environmentTitle?: string;
  alertDetailPath: (alertId: string) => string;
  addChannel?: AddChannelAccess;
  queueMetricsEnabled?: boolean;
  onShown?: () => void;
  sendText?: (text: string) => void;
  wizardSlot?: HTMLElement | null;
  setWizardSlot?: (slot: HTMLElement | null) => void;
};

const HostContext = createContext<MonitoringPlanHost | undefined>(undefined);
export const MonitoringPlanHostProvider = HostContext.Provider;

export function PlanWizardSlot() {
  const host = useContext(HostContext);
  return (
    <div className="relative shrink-0">
      <div
        ref={host?.setWizardSlot}
        data-testid="plan-wizard-slot"
        className="absolute inset-x-3 bottom-full z-10 mb-1"
      />
    </div>
  );
}

function PlanWizardPortal({ host, children }: { host: MonitoringPlanHost; children: ReactNode }) {
  return host.wizardSlot ? createPortal(children, host.wizardSlot) : null;
}

const CreatedAlertsContext = createContext<ReadonlyMap<string, string>>(new Map());

function useCreatedAlertsByPlanItem(messages: UIMessage[]): ReadonlyMap<string, string> {
  const pairs: [string, string][] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const p = part as { type: string; data?: { blocks?: unknown[] } };
      if (p.type !== "data-view") continue;
      for (const block of p.data?.blocks ?? []) {
        const b = block as { type?: string; planItemKey?: string; alertId?: string };
        if (b.type === "alert_created" && b.planItemKey && b.alertId) {
          for (const key of splitPlanItemKeys(b.planItemKey)) pairs.push([key, b.alertId]);
        }
      }
    }
  }
  const key = JSON.stringify(pairs);
  return useMemo(() => new Map(JSON.parse(key) as [string, string][]), [key]);
}

const NOT_THIS = "Not this";

type PlanTranscript = {
  latest: ReadonlyMap<string, string>;
  dismissed: ReadonlySet<string>;
  confirmed: ReadonlyMap<string, number>;
  lastPlan?: string;
  beforePlan: ReadonlySet<string>;
};
const PlanTranscriptContext = createContext<PlanTranscript>({
  latest: new Map(),
  dismissed: new Set(),
  confirmed: new Map(),
  beforePlan: new Set(),
});

function messageText(message: UIMessage): string {
  return (message.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

function usePlanTranscript(messages: UIMessage[]): PlanTranscript {
  const key = useMemo(() => {
    const latest: [string, string][] = [];
    const dismissed: string[] = [];
    const confirmed: string[] = [];
    let lastPlan: string | undefined;
    const seen: string[] = [];
    const beforePlan: string[] = [];
    let unanswered: string[] = [];
    for (const message of messages) {
      seen.push(message.id);
      if (message.role === "user") {
        if (messageText(message) === NOT_THIS) dismissed.push(...unanswered);
        unanswered = [];
        continue;
      }
      (message.parts ?? []).forEach((part, i) => {
        const p = part as { type: string; state?: string; toolCallId?: string; output?: unknown };
        if (p.type === "tool-plan_decision" && p.state === "output-available" && lastPlan) {
          const decision = (p.output as Partial<PlanDecisionOutput> | undefined)?.decision;
          if (decision === "confirm") confirmed.push(lastPlan);
          if (decision === "dismiss") dismissed.push(lastPlan);
          return;
        }
        if (p.type !== "tool-plan_monitoring" || p.state !== "output-available") return;
        const plan = parsePlanOutput(p.output);
        const planKey = p.toolCallId ?? String(i);
        if (!plan) return;
        lastPlan = planKey;
        latest.push([plan.lineage ?? planKey, planKey]);
        unanswered.push(planKey);
        beforePlan.push(...seen.slice(0, -1));
      });
    }
    return JSON.stringify({
      latest,
      dismissed,
      confirmed,
      lastPlan,
      beforePlan: [...new Set(beforePlan)],
    });
  }, [messages]);
  return useMemo(() => {
    const parsed = JSON.parse(key) as {
      latest: [string, string][];
      dismissed: string[];
      confirmed: string[];
      lastPlan?: string;
      beforePlan: string[];
    };
    return {
      latest: new Map(parsed.latest),
      dismissed: new Set(parsed.dismissed),
      confirmed: parsed.confirmed.reduce(
        (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1),
        new Map<string, number>()
      ),
      lastPlan: parsed.lastPlan,
      beforePlan: new Set(parsed.beforePlan),
    };
  }, [key]);
}

export function PlanMessagesProvider({
  messages,
  children,
}: {
  messages: UIMessage[];
  children: ReactNode;
}) {
  const created = useCreatedAlertsByPlanItem(messages);
  const transcript = usePlanTranscript(messages);
  return (
    <CreatedAlertsContext.Provider value={created}>
      <PlanTranscriptContext.Provider value={transcript}>{children}</PlanTranscriptContext.Provider>
    </CreatedAlertsContext.Provider>
  );
}

function draftNotifiers(draft: AlertDraftPatch): string[] {
  return applyDraftPatch({}, draft).notifiers ?? [];
}

function withDefaultParams(answers: FlowAnswers): FlowAnswers {
  if (!requiredParams(answers.what, answers.components).length) return answers;
  const defaults = capabilityParams(answers.what, answers.components).map((p) => [
    p.key,
    p.default,
  ]);
  return {
    ...answers,
    conditionParams: { ...Object.fromEntries(defaults), ...answers.conditionParams },
  };
}

function planItemAnswers(draft: AlertDraftPatch): FlowAnswers {
  const answers = withDefaultParams(
    withAutoAnswers(applyDraftPatch({ notifiers: [], expiry: "none" }, draft))
  );
  const coversAll = resolveCapability(answers.what)?.allowedScopes.includes("all");
  return answers.scope === undefined && coversAll ? { ...answers, scope: "all" } : answers;
}

function planQueryPrefill(draft: AlertDraftPatch): QueryWatchPrefill | undefined {
  const watch = queryWatchFromPatch(draft);
  if (!watch) return undefined;
  const answers = applyDraftPatch({}, draft);
  return {
    ...watch,
    name: draft.name,
    expiry: answers.expiry ?? "none",
    notifiers: answers.notifiers,
  };
}

function withHorizon(item: MonitoringPlanItem, horizon: string | undefined): MonitoringPlanItem {
  const { behavior } = item.draft;
  if (!horizon || behavior?.expiry !== undefined || behavior?.expiresAt !== undefined) return item;
  return { ...item, draft: { ...item.draft, behavior: { ...behavior, expiry: horizon } } };
}

function hasCondition(item: MonitoringPlanItem): boolean {
  return (
    Boolean(planQueryPrefill(item.draft)) ||
    item.draft.condition?.kind === "state" ||
    !draftMissing(planItemAnswers(item.draft)).includes("condition")
  );
}

const itemSummary = (item: MonitoringPlanItem) => item.summary ?? item.title;
const itemDetail = (item: MonitoringPlanItem) => item.detail ?? item.description;

function itemDescription(item: MonitoringPlanItem): string {
  const capability = item.draft.what ? resolveCapability(item.draft.what) : undefined;
  return capability?.description ?? itemDetail(item);
}

function planIntro(plan: MonitoringPlan, refs: PlanItemRef[]): string {
  return (
    plan.intro?.trim() ||
    `I suggest watching: ${refs.map((ref) => itemSummary(ref.item)).join(", ")}. Sounds good?`
  );
}

function chatFor(host: MonitoringPlanHost, planRef: PlanItemRef): QueryAlertChat | undefined {
  const chatId = host.chatId;
  return chatId
    ? { planItemKey: createdAlertKey(planRef), ensure: async () => ({ chatId }) }
    : undefined;
}

function planChatRequest(host: MonitoringPlanHost, planRef: PlanItemRef) {
  return host.chatId
    ? { transcriptChatId: host.chatId, planItemKey: createdAlertKey(planRef) }
    : undefined;
}

function useRequestIds() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return { organizationId: organization.id, projectId: project.id, environmentId: environment.id };
}

const OTHER_ENVIRONMENT = "This plan is for another environment";
const INCOMPLETE = "Answer every step to create";
const NOTHING_PICKED = "Pick at least one alert";
const ALREADY_CREATED = "Already created";
const CURATED_STEPS = ["scope", "condition"];
const QUERY_STEPS = ["signal", "condition", "threshold", "window"];
const HOW_OPTIONS = [
  { id: "combined", label: "As a group" },
  { id: "separate", label: "Separately" },
];

function createdStatus(
  createdByKey: ReadonlyMap<string, string>,
  planRef: PlanItemRef
): PlanItemStatus | undefined {
  const alertId = createdByKey.get(createdAlertKey(planRef));
  return alertId ? { kind: "created", alertId } : undefined;
}

type PlanToolOutput = { ok?: boolean; plan?: unknown };

function parsePlanOutput(output: unknown): MonitoringPlan | undefined {
  const result = output as PlanToolOutput | undefined;
  return result?.ok ? parseMonitoringPlan(result.plan) : undefined;
}

export function MonitoringPlanBlock({ planKey, output }: { planKey: string; output: unknown }) {
  const onShown = useContext(HostContext)?.onShown;
  const plan = parsePlanOutput(output);
  const shown = Boolean(plan);
  useEffect(() => {
    if (shown) onShown?.();
  }, [onShown, shown]);
  return plan ? <PlanItems planKey={planKey} plan={plan} /> : null;
}

function planView(
  planKey: string,
  plan: MonitoringPlan,
  host: MonitoringPlanHost,
  createdByKey: ReadonlyMap<string, string>,
  transcript: PlanTranscript
) {
  const lineage = plan.lineage ?? planKey;
  const refs: PlanItemRef[] = plan.items.filter(hasCondition).map((item) => ({
    key: planItemKey(planKey, item.id),
    item: withHorizon(item, plan.horizon),
    lineage: plan.lineage,
  }));
  const stored = host.flowFor(lineage, planKey);
  const statusOf = (ref: PlanItemRef) => host.statusFor(ref) ?? createdStatus(createdByKey, ref);
  const latest = transcript.latest.get(lineage);
  const superseded = latest !== undefined && latest !== planKey;
  const dismissed = transcript.dismissed.has(planKey);
  const picked = refs.filter((ref) => {
    const key = createdAlertKey(ref);
    return !stored.unselected.includes(key) && !stored.unavailable?.includes(key);
  });
  const allCreated = picked.length > 0 && picked.every((ref) => statusOf(ref));
  const flow = stored;
  const done = !flow.open && allCreated;
  return {
    lineage,
    refs,
    flow,
    statusOf,
    superseded,
    done,
    live: !superseded && !done && !dismissed,
  };
}

export function useFollowedByPlan(messageId: string): boolean {
  return useContext(PlanTranscriptContext).beforePlan.has(messageId);
}

export function useLiveProposal(): (part: UIMessage["parts"][number], index: number) => boolean {
  const host = useContext(HostContext);
  const createdByKey = useContext(CreatedAlertsContext);
  const transcript = useContext(PlanTranscriptContext);
  return (part, index) => {
    const p = part as { type: string; state?: string; toolCallId?: string; output?: unknown };
    if (p.type !== "tool-plan_monitoring" || p.state !== "output-available") return false;
    const plan = parsePlanOutput(p.output);
    if (!plan) return false;
    if (!host) return true;
    return planView(p.toolCallId ?? String(index), plan, host, createdByKey, transcript).live;
  };
}

function PlanItems({ planKey, plan }: { planKey: string; plan: MonitoringPlan }) {
  const pageHost = useContext(HostContext);
  const environment = useOptionalEnvironment();
  const otherEnvironment = Boolean(plan.environmentId && plan.environmentId !== environment?.id);
  const host = useMemo(
    () => (pageHost && otherEnvironment ? { ...pageHost, environmentTitle: undefined } : pageHost),
    [pageHost, otherEnvironment]
  );
  const createdByKey = useContext(CreatedAlertsContext);
  const transcript = useContext(PlanTranscriptContext);
  const view = host ? planView(planKey, plan, host, createdByKey, transcript) : undefined;
  const confirms = transcript.confirmed.get(planKey) ?? 0;
  const autoOpen = Boolean(view?.live) && planKey === transcript.lastPlan;
  const updateFlow = host?.updateFlow;
  const lineage = view?.lineage;
  const handledConfirms = useRef(0);
  useEffect(() => {
    if (confirms === handledConfirms.current) return;
    handledConfirms.current = confirms;
    if (confirms > 0 && autoOpen && updateFlow && lineage) {
      updateFlow(lineage, planKey, { open: true });
    }
  }, [confirms, autoOpen, updateFlow, lineage, planKey]);
  if (!host || !view) {
    const refs = plan.items.map((item) => ({ key: item.id, item }));
    return <ChatText text={planIntro(plan, refs)} />;
  }
  const { refs, flow, statusOf, superseded, live } = view;
  const setFlow = (patch: Partial<PlanFlow>) => host.updateFlow(view.lineage, planKey, patch);
  const inTranscript = new Set(createdByKey.values());
  const placeholders = superseded
    ? []
    : [
        ...(flow.group ? [] : refs.map((ref) => host.createdHere(ref))),
        flow.group && { kind: "created" as const, ...flow.group },
      ].flatMap((status) =>
        status && status.block && status.alertId && !inTranscript.has(status.alertId)
          ? [status.block]
          : []
      );

  return (
    <HostContext.Provider value={host}>
      {placeholders.map((block) => (
        <ChatCardSlot key={block.alertId}>
          <AlertCreatedCard block={block} />
        </ChatCardSlot>
      ))}
      {!live ? null : (
        <>
          <ChatText text={planIntro(plan, refs)} />
          <ul className="flex flex-col gap-1 text-sm text-text-dimmed">
            {refs.map((ref) => (
              <li key={ref.key}>
                <span className="font-medium text-text-bright">{itemSummary(ref.item)}</span>
                {` — ${itemDetail(ref.item)}`}
              </li>
            ))}
          </ul>
          {transcript.confirmed.has(planKey) && flow.open ? null : (
            <ChatActionsRow>
              <Button variant="primary/small" onClick={() => setFlow({ open: true })}>
                Sounds good
              </Button>
              <Button
                variant="secondary/small"
                onClick={() => {
                  setFlow({ open: false });
                  host.sendText?.(NOT_THIS);
                }}
              >
                Not this
              </Button>
            </ChatActionsRow>
          )}
        </>
      )}
      {live ? (
        <AnalysisChain
          refs={refs}
          done={[]}
          render={(analyses) =>
            analyses.every((analysis) => !analysis || analysis.analyzed !== undefined) ? (
              <ItemChain
                refs={refs}
                analyses={analyses}
                done={[]}
                host={host}
                render={(items) => (
                  <>
                    <UnavailableSync items={items} flow={flow} setFlow={setFlow} />
                    {flow.open ? (
                      <PlanWizardPortal host={host}>
                        <PlanWizard
                          plan={plan}
                          items={items}
                          host={host}
                          flow={flow}
                          setFlow={setFlow}
                          isCreated={(ref) => Boolean(statusOf(ref))}
                          blockedReason={otherEnvironment ? OTHER_ENVIRONMENT : undefined}
                        />
                      </PlanWizardPortal>
                    ) : null}
                  </>
                )}
              />
            ) : null
          }
        />
      ) : null}
    </HostContext.Provider>
  );
}

function UnavailableSync({
  items,
  flow,
  setFlow,
}: {
  items: PlanItemApi[];
  flow: PlanFlow;
  setFlow: (patch: Partial<PlanFlow>) => void;
}) {
  const keys = items.filter((item) => item.unavailable).map((item) => createdAlertKey(item.ref));
  const json = JSON.stringify(keys);
  useEffect(() => {
    if (json !== JSON.stringify(flow.unavailable ?? [])) setFlow({ unavailable: keys });
  }, [json]); // eslint-disable-line react-hooks/exhaustive-deps -- sync on change only
  return null;
}

type RequestBody = { form: object; transcriptChatId?: string };

type PlanItemApi = {
  ref: PlanItemRef;
  steps: ChatWizardStep[];
  select: (stepId: string, value: string) => boolean;
  confirm: (stepId: string) => void;
  name: string;
  typedName?: string;
  setName: (name: string) => void;
  build: (notifiers: string[]) => RequestBody;
  incomplete: boolean;
  unavailable?: string;
};

type QueryAnalysis = ReturnType<typeof useQueryAnalysis>;

type AnalysisProps = {
  refs: PlanItemRef[];
  done: (QueryAnalysis | undefined)[];
  render: (analyses: (QueryAnalysis | undefined)[]) => ReactNode;
};

function AnalysisChain({ refs, done, render }: AnalysisProps) {
  const [planRef, ...rest] = refs;
  if (!planRef) return render(done);
  const query = planQueryPrefill(planRef.item.draft);
  const next = { refs: rest, done, render };
  return query ? (
    <QueryAnalysisNode
      prefill={{ ...query, name: query.name ?? planRef.item.summary }}
      next={next}
    />
  ) : (
    <AnalysisChain {...next} done={[...done, undefined]} />
  );
}

function QueryAnalysisNode({ prefill, next }: { prefill: QueryWatchPrefill; next: AnalysisProps }) {
  const analysis = useQueryAnalysis(prefill);
  return <AnalysisChain {...next} done={[...next.done, analysis]} />;
}

type ChainProps = {
  refs: PlanItemRef[];
  analyses: (QueryAnalysis | undefined)[];
  done: PlanItemApi[];
  host: MonitoringPlanHost;
  render: (items: PlanItemApi[]) => ReactNode;
};

function ItemChain({ refs, analyses, done, host, render }: ChainProps) {
  const [planRef, ...rest] = refs;
  const [analysis, ...restAnalyses] = analyses;
  if (!planRef) return render(done);
  const next = { refs: rest, analyses: restAnalyses, done, host, render };
  return analysis ? (
    <QueryItemNode planRef={planRef} analysis={analysis} next={next} />
  ) : (
    <CuratedItemNode planRef={planRef} next={next} />
  );
}

function CuratedItemNode({ planRef, next }: { planRef: PlanItemRef; next: ChainProps }) {
  const { host } = next;
  const ids = useRequestIds();
  const flow = useCreationFlowState(undefined, planItemAnswers(planRef.item.draft));
  const [entities, setEntities] = useState<ScopeEntities>();
  const [entitySearch, setEntitySearch] = useState("");
  const kind = scopeEntityKindFor(flow.answers);
  const steps = allSteps(
    flow,
    host.channels ?? [],
    undefined,
    undefined,
    entities?.kind === kind ? entities?.names : undefined,
    [],
    setEntitySearch,
    host.queueMetricsEnabled === false ? ["queues"] : []
  ).filter((step) => CURATED_STEPS.includes(step.id));
  const item: PlanItemApi = {
    ref: planRef,
    steps,
    select: (id, value) => {
      const step = steps.find((s) => s.id === id);
      if (!step?.multiSelect && step?.selected?.includes(value)) return true;
      applyStepSelection(flow, id, value, { onShowAll: () => {}, onAddChannel: () => {} });
      return !(step?.multiSelect || (id === "scope" && needsScopeValue(value)));
    },
    confirm: (id) => confirmStep(flow, id),
    name: alertName(flow.answers),
    typedName: flow.answers.name,
    setName: flow.setName,
    build: (notifiers) =>
      createAlertRequestBody(ids, { ...flow.answers, notifiers }, planChatRequest(host, planRef)),
    incomplete: draftMissing(flow.answers).length > 0,
  };
  return (
    <>
      {kind ? (
        <ScopeEntitiesLoader
          kind={kind}
          current={flow.answers.scopeValue}
          search={entitySearch}
          onLoad={setEntities}
        />
      ) : null}
      <ItemChain {...next} done={[...next.done, item]} />
    </>
  );
}

function QueryItemNode({
  planRef,
  analysis,
  next,
}: {
  planRef: PlanItemRef;
  analysis: QueryAnalysis;
  next: ChainProps;
}) {
  const { full, reasons } = analysis;
  if (full && !reasons.length)
    return <QueryDraftNode planRef={planRef} prefill={full} next={next} />;
  const item: PlanItemApi = {
    ref: planRef,
    steps: [],
    select: () => true,
    confirm: () => {},
    name: planRef.item.title,
    setName: () => {},
    build: () => ({ form: {} }),
    incomplete: true,
    unavailable: reasons[0] ?? UNUSABLE_QUERY,
  };
  return <ItemChain {...next} done={[...next.done, item]} />;
}

function QueryDraftNode({
  planRef,
  prefill,
  next,
}: {
  planRef: PlanItemRef;
  prefill: QueryAlertPrefill;
  next: ChainProps;
}) {
  const { host } = next;
  const ids = useRequestIds();
  const draft = useQueryAlertDraft(
    prefill,
    (alertId) => host.markCreated(planRef, alertId),
    chatFor(host, planRef)
  );
  const wizard = useQueryAlertWizard(draft, prefill, { onDone: () => {}, initiallyAnswered: true });
  const item: PlanItemApi = {
    ref: planRef,
    steps: wizard.steps.filter((step) => QUERY_STEPS.includes(step.id)),
    select: (id, value) => {
      wizard.select(id, value);
      return true;
    },
    confirm: () => {},
    name: draft.name,
    typedName: draft.name,
    setName: draft.setEditedName,
    build: (notifiers) =>
      queryAlertRequestBody(
        ids,
        {
          query: draft.query,
          name: draft.name.trim(),
          mode: draft.mode,
          measure: draft.measure,
          operator: draft.operator,
          value: draft.value,
          windowMinutes: draft.windowMinutes,
          expiry: draft.flow.answers.expiry,
          notifiers,
        },
        planChatRequest(host, planRef)
      ),
    incomplete: !(draft.valueValid && draft.windowValid && draft.name.trim()),
  };
  return <ItemChain {...next} done={[...next.done, item]} />;
}

type WizardEntry = { key: string; step: ChatWizardStep; item?: PlanItemApi };
type WizardPosition = { id: string } | { after: string };

function positionIndex(entries: WizardEntry[], position: WizardPosition): number {
  const last = entries.length - 1;
  if (!("after" in position)) {
    return Math.max(
      0,
      entries.findIndex((entry) => entry.key === position.id)
    );
  }
  const at = entries.findIndex((entry) => entry.key === position.after);
  return at < 0 ? last : Math.min(last, at + 1);
}

function toggled(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

async function postJson(path: string, body: unknown) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    alertId?: string;
    memberAlertIds?: string[];
    message?: AlertCreatedMessage;
    error?: string;
  };
  return { ok: resp.ok && Boolean(data.alertId), status: resp.status, data };
}

function PlanWizard({
  plan,
  items,
  host,
  flow,
  setFlow,
  isCreated,
  blockedReason,
}: {
  plan: MonitoringPlan;
  items: PlanItemApi[];
  host: MonitoringPlanHost;
  flow: PlanFlow;
  setFlow: (patch: Partial<PlanFlow>) => void;
  isCreated: (ref: PlanItemRef) => boolean;
  blockedReason?: string;
}) {
  const ids = useRequestIds();
  const maxHeight = useWizardMaxHeight(host.wizardSlot?.parentElement?.previousElementSibling);
  const [position, setPosition] = useState<WizardPosition>({ id: "what" });
  const [addingChannel, setAddingChannel] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);

  const available = items.filter((item) => !item.unavailable && !isCreated(item.ref));
  const selected = available.filter((item) => !flow.unselected.includes(createdAlertKey(item.ref)));
  const mode = flow.mode ?? (plan.group ? "combined" : undefined);
  const grouped = selected.length >= 2 && mode === "combined";
  const notifiers = flow.notifiers ?? [
    ...new Set(selected.flatMap((item) => draftNotifiers(item.ref.item.draft))),
  ];
  const name = flow.name ?? (plan.goal.trim().slice(0, 120) || defaultGroupName(selected.length));
  const context = (index: number) =>
    selected.length > 1
      ? `${index + 1} of ${selected.length} · ${itemSummary(selected[index]!.ref.item)}`
      : undefined;

  const entries: WizardEntry[] = [
    {
      key: "what",
      step: {
        id: "what",
        question: "What to watch?",
        allowSkip: false,
        multiSelect: true,
        options: items.map((item) => ({
          id: item.ref.key,
          label: itemSummary(item.ref.item),
          detail: itemDescription(item.ref.item),
          codeBlock: planQueryPrefill(item.ref.item.draft) ? (
            <QueryBlock query={planQueryPrefill(item.ref.item.draft)!.query} />
          ) : undefined,
          truncate: true,
          disabledReason: isCreated(item.ref) ? ALREADY_CREATED : item.unavailable,
        })),
        selected: selected.map((item) => item.ref.key),
        confirmLabel: "Continue",
        error: selected.length ? undefined : NOTHING_PICKED,
      },
    },
    ...(selected.length >= 2
      ? [
          {
            key: "how",
            step: {
              id: "how",
              question: "One alert or separate?",
              allowSkip: false,
              options: HOW_OPTIONS,
              selected: mode ? [mode] : [],
            },
          },
        ]
      : []),
    ...selected.flatMap((item, index) => [
      ...(selected.length < 2
        ? []
        : [
            {
              key: `${item.ref.key}:intro`,
              step: {
                id: "intro",
                question: itemSummary(item.ref.item),
                context: context(index),
                allowSkip: false,
                content: (
                  <div className="flex flex-col gap-1 text-xs text-text-dimmed">
                    <p>{itemDescription(item.ref.item)}</p>
                    {planQueryPrefill(item.ref.item.draft) ? (
                      <QueryBlock query={planQueryPrefill(item.ref.item.draft)!.query} />
                    ) : null}
                  </div>
                ),
                options: [],
                multiSelect: true,
                selected: ["intro"],
                confirmLabel: "Continue",
              },
            },
          ]),
      ...item.steps.map((step) => ({
        key: `${item.ref.key}:${step.id}`,
        step: { ...step, context: context(index) },
        item,
      })),
    ]),
    {
      key: "notifiers",
      step: {
        ...notifiersStep(host.channels ?? [], notifiers, host.addChannel),
        confirmLabel: "Continue",
      },
    },
    ...(grouped
      ? [{ key: "name", step: nameStep(name, flow.name, (value) => setFlow({ name: value })) }]
      : selected.map((item, index) => ({
          key: `${item.ref.key}:name`,
          step: { ...nameStep(item.name, item.typedName, item.setName), context: context(index) },
        }))),
  ];
  const last = entries.length - 1;
  const reason =
    blockedReason ?? (selected.some((item) => item.incomplete) ? INCOMPLETE : undefined) ?? error;
  const finalStep = entries[last]!.step;
  entries[last] = {
    ...entries[last]!,
    step: {
      ...finalStep,
      confirmLabel: submitting ? "Creating…" : "Create",
      confirmDisabled:
        finalStep.confirmDisabled ||
        submitting ||
        Boolean(blockedReason) ||
        selected.some((item) => item.incomplete),
      error: finalStep.error ?? reason,
    },
  };

  const index = positionIndex(entries, position);
  const entry = entries[index]!;
  const advance = () => setPosition({ after: entry.key });

  const create = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      if (grouped) {
        const body = groupAlertsBody(
          ids,
          {
            members: selected.map((item) => {
              const { transcriptChatId: _, ...member } = item.build(notifiers);
              return member;
            }),
            compositeMode: "any",
            name: name.trim(),
            notifiers,
            expiry: plan.horizon,
          },
          host.chatId
        );
        const { ok, status, data } = await postJson(GROUP_ALERTS_PATH, body);
        if (!ok) return setError(createAlertErrorMessage(status, data.error));
        selected.forEach((item, i) => host.markCreated(item.ref, data.memberAlertIds?.[i]));
        setFlow({
          open: false,
          group: { alertId: data.alertId!, block: data.message?.parts[1].data.blocks[0] },
        });
        return;
      }
      for (const item of selected) {
        const { ok, status, data } = await postJson(CREATE_ALERT_PATH, item.build(notifiers));
        if (!ok) return setError(createAlertErrorMessage(status, data.error));
        host.markCreated(item.ref, data.alertId, data.message?.parts[1].data.blocks[0]);
      }
      setFlow({ open: false });
    } catch {
      setError(createAlertErrorMessage(0, undefined));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const select = (_stepId: string, value: string) => {
    if (entry.key === "what") {
      const item = items.find((i) => i.ref.key === value);
      if (item) setFlow({ unselected: toggled(flow.unselected, createdAlertKey(item.ref)) });
    } else if (entry.key === "how") {
      setFlow({ mode: value as PlanFlow["mode"] });
      advance();
    } else if (entry.key === "notifiers") {
      if (value === ADD_CHANNEL_OPTION) setAddingChannel(true);
      else setFlow({ notifiers: toggled(notifiers, value) });
    } else if (entry.item?.select(entry.step.id, value)) {
      advance();
    }
  };

  return (
    <>
      <ChatWizardCard
        steps={entries.map((e) => e.step)}
        stepIndex={index}
        onStepChange={(next) => setPosition({ id: entries[next]?.key ?? "what" })}
        onSelect={select}
        onSkip={() => {}}
        onClose={() => setFlow({ open: false })}
        onConfirm={(stepId) => {
          if (index === last) return void create();
          entry.item?.confirm(stepId);
          advance();
        }}
        maxHeight={maxHeight}
      />
      {addingChannel && host.addChannel ? (
        <AlertChannelsDialog
          open
          connectReturnTo={host.addChannel.connectReturnTo}
          onCreated={(channel) => {
            if (!notifiers.includes(channel.id)) setFlow({ notifiers: [...notifiers, channel.id] });
          }}
          onClose={() => {
            setAddingChannel(false);
            host.addChannel?.onCreated?.();
          }}
        />
      ) : null}
    </>
  );
}
