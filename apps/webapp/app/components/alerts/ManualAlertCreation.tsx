import { useFetcher } from "@remix-run/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { PanelHandle } from "@window-splitter/react";
import { alertChannelsResourcePath } from "~/components/alerts/alertChannelsResourcePath";
import { CreationChatShell } from "~/components/alerts/CreationChatShell";
import {
  CREATE_ALERT_PATH,
  createAlertRequestBody,
  replaceRequestBody,
} from "~/components/alerts/createAlertRequest";
import { LEGACY_ALERTS_ROUTE_ID } from "~/components/alerts/legacyAlertChannels";
import type { AlertChannel } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  useCreationFlowState,
  type FlowAnswers,
} from "~/components/dashboard-agent/alert-creation";
import {
  prefillToAnswers,
  type DraftPrefillParams,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { ManualCreationForm } from "~/components/dashboard-agent/alert-creation/ManualCreationForm";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import {
  DashboardPanelHeader,
  PANEL_TITLE_CLASS,
} from "~/components/dashboard-agent/DashboardPanelChrome";
import {
  createDockedWidthController,
  type DockedWidthAction,
} from "~/components/dashboard-agent/docked-width";
import { escapeClosesPanel, ownsEscape } from "~/components/dashboard-agent/panel-escape";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MAX_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  readAgentPanelWidth,
  writeAgentPanelWidth,
} from "~/components/dashboard-agent/panel-layout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { v3ProjectLegacyAlertsPath } from "~/utils/pathBuilder";

function prefillAnswers(prefill: DraftPrefillParams): FlowAnswers {
  const base =
    prefill.area || prefill.capability || prefill.scope || prefill.replace
      ? prefillToAnswers(prefill)
      : {};
  return { notifiers: [], ...base };
}

type ReplacedResult = { legacyRemaining?: boolean; message?: string };

function ManualAlertCreation({
  prefill,
  alertDetailPath,
  onCreated,
  onReplaced,
}: {
  prefill: DraftPrefillParams;
  alertDetailPath: (alertId: string) => string;
  onCreated: (alertId: string | undefined) => void;
  onReplaced?: (result: ReplacedResult) => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { queueMetricsEnabled } = useFeatures();
  const [initialAnswers] = useState(() => prefillAnswers(prefill));
  const [resetKey, setResetKey] = useState(0);

  const onSubmit = useCallback(
    async (answers: FlowAnswers) => {
      try {
        if (answers.replace) {
          const resp = await fetch(
            `${v3ProjectLegacyAlertsPath(organization, project, environment)}?_data=${encodeURIComponent(LEGACY_ALERTS_ROUTE_ID)}`,
            { method: "POST", body: replaceRequestBody(answers) }
          );
          if (!resp.ok) return false;
          onReplaced?.((await resp.json()) as ReplacedResult);
          return true;
        }
        const resp = await fetch(CREATE_ALERT_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            createAlertRequestBody(
              {
                organizationId: organization.id,
                projectId: project.id,
                environmentId: environment.id,
              },
              answers
            )
          ),
        });
        if (!resp.ok) return false;
        const data = (await resp.json()) as { alertId?: string };
        onCreated(data.alertId);
        return data.alertId ? { alertId: data.alertId } : true;
      } catch {
        return false;
      }
    },
    [organization, project, environment, onCreated, onReplaced]
  );
  const flow = useCreationFlowState(onSubmit, initialAnswers, resetKey);

  const channelsFetcher = useFetcher<{
    channels: AlertChannel[];
    canWrite?: boolean;
    limits?: { used: number; limit: number };
  }>();
  const channelsPath = alertChannelsResourcePath(
    project.id,
    false,
    prefill.replace ? undefined : environment.id
  );
  useEffect(() => {
    channelsFetcher.load(channelsPath);
  }, [channelsPath]); // eslint-disable-line react-hooks/exhaustive-deps -- fetcher is stable
  const limits = channelsFetcher.data?.limits;

  return (
    <ManualCreationForm
      flow={flow}
      channels={channelsFetcher.data?.channels ?? []}
      addChannel={{
        projectId: project.id,
        canWrite: channelsFetcher.data?.canWrite ?? false,
        atLimit: limits ? limits.used >= limits.limit : false,
        onCreated: () => channelsFetcher.load(channelsPath),
      }}
      emptyAreas={queueMetricsEnabled ? [] : ["queues"]}
      onStartOver={() => setResetKey((key) => key + 1)}
      environmentTitle={environmentFullTitle(environment)}
      alertDetailPath={flow.createdAlertId ? alertDetailPath(flow.createdAlertId) : undefined}
    />
  );
}

/* oxlint-disable jsx-a11y/no-static-element-interactions -- Escape bubbles from focused controls inside the panel. */
function ManualAlertCreationPanel({
  prefill,
  alertDetailPath,
  onCreated,
  onReplaced,
  onClose,
}: {
  prefill: DraftPrefillParams;
  alertDetailPath: (alertId: string) => string;
  onCreated: (alertId: string | undefined) => void;
  onReplaced?: (result: ReplacedResult) => void;
  onClose: () => void;
}) {
  const environment = useEnvironment();
  const panelRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={panelRef}
      data-testid="manual-alert-panel"
      className="flex h-full flex-col bg-background-bright max-sm:fixed max-sm:inset-0 max-sm:z-40"
      onKeyDown={(event) => {
        if (
          !escapeClosesPanel({
            key: event.key,
            defaultPrevented: event.defaultPrevented,
            targetInsidePanel: panelRef.current?.contains(event.target as Node) ?? false,
            targetInDialog: Boolean((event.target as Element).closest?.("[data-dialog]")),
            targetExpanded: ownsEscape(event.target as Element),
          })
        )
          return;
        event.preventDefault();
        onClose();
      }}
    >
      <DashboardPanelHeader
        title={<span className={cn("px-1", PANEL_TITLE_CLASS)}>New alert</span>}
        onClose={onClose}
      />
      <CreationChatShell placement="docked" title="New alert">
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ManualAlertCreation
            key={`${environment.id}:${JSON.stringify(prefill)}`}
            prefill={prefill}
            alertDetailPath={alertDetailPath}
            onCreated={onCreated}
            onReplaced={onReplaced}
          />
        </div>
      </CreationChatShell>
    </div>
  );
}

/* oxlint-enable jsx-a11y/no-static-element-interactions */

export function ManualAlertCreationDock({
  open,
  prefill,
  alertDetailPath,
  onCreated,
  onReplaced,
  onClose,
  children,
}: {
  open: boolean;
  prefill: DraftPrefillParams;
  alertDetailPath: (alertId: string) => string;
  onCreated: (alertId: string | undefined) => void;
  onReplaced?: (result: ReplacedResult) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelHandle = useRef<PanelHandle>(null);
  const dockedWidth = useRef(createDockedWidthController());
  const runWidthAction = useCallback((action: DockedWidthAction) => {
    if (action.type === "apply") panelHandle.current?.setSize(`${action.width}px`);
    if (action.type === "persist") writeAgentPanelWidth(action.width);
  }, []);
  useEffect(() => {
    const controller = dockedWidth.current;
    runWidthAction(
      open
        ? controller.dock(readAgentPanelWidth(), panelHandle.current?.getPixelSize())
        : controller.undock()
    );
  }, [open, runWidthAction]);

  if (!open) return children;

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
      <ResizablePanel id="dashboard-content" min="320px">
        <div className="h-full overflow-hidden">{children}</div>
      </ResizablePanel>
      <ResizableHandle
        id="dashboard-agent-handle"
        onDragEnd={() =>
          runWidthAction(dockedWidth.current.dragEnd(panelHandle.current?.getPixelSize()))
        }
      />
      <ResizablePanel
        id="dashboard-agent-panel"
        handle={panelHandle}
        onResize={({ pixel }: { pixel: number }) =>
          runWidthAction(dockedWidth.current.resize(pixel))
        }
        default={`${AGENT_PANEL_DEFAULT_WIDTH}px`}
        min={`${AGENT_PANEL_MIN_WIDTH}px`}
        max={`${AGENT_PANEL_MAX_WIDTH}px`}
      >
        <ManualAlertCreationPanel
          prefill={prefill}
          alertDetailPath={alertDetailPath}
          onCreated={onCreated}
          onReplaced={onReplaced}
          onClose={onClose}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
