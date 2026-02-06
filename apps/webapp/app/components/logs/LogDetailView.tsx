import { XMarkIcon, ArrowTopRightOnSquareIcon, CheckIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import {
  type MachinePresetName,
  formatDurationMilliseconds,
} from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { cn } from "~/utils/cn";
import { Button } from "~/components/primitives/Buttons";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import * as Property from "~/components/primitives/PropertyTable";
import { TextLink } from "~/components/primitives/TextLink";
import { CopyableText } from "~/components/primitives/CopyableText";
import { SimpleTooltip, InfoIconTooltip } from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import { getLevelColor } from "~/utils/logUtils";
import { v3RunSpanPath, v3RunsPath, v3DeploymentVersionPath } from "~/utils/pathBuilder";
import type { loader as logDetailLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs.$logId";
import { TaskRunStatusCombo, descriptionForTaskRunStatus } from "~/components/runs/v3/TaskRunStatus";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { RunTag } from "~/components/runs/v3/RunTag";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import type { TaskRunStatus } from "@trigger.dev/database";
import { PacketDisplay } from "~/components/runs/v3/PacketDisplay";
import type { RunContext } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs.$logId.run";

type RunContextData = {
  run: RunContext | null;
};


type LogDetailViewProps = {
  logId: string;
  // If we have the log entry from the list, we can display it immediately
  initialLog?: LogEntry;
  onClose: () => void;
  searchTerm?: string;
};

type TabType = "details" | "run";

type LogAttributes = Record<string, unknown> & {
  error?: {
    message?: string;
  };
};

function formatStringJSON(str: string): string {
  return str
    .replace(/\\n/g, "\n") // Converts literal "\n" to newline
    .replace(/\\t/g, "\t"); // Converts literal "\t" to tab
}


export function LogDetailView({ logId, initialLog, onClose, searchTerm }: LogDetailViewProps) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof logDetailLoader>();
  const [activeTab, setActiveTab] = useState<TabType>("details");
  const [error, setError] = useState<string | null>(null);

  // Fetch full log details when logId changes
  useEffect(() => {
    if (!logId) return;

    setError(null);
    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/logs/${encodeURIComponent(logId)}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization.slug, project.slug, environment.slug, logId]);

  // Handle fetch errors
  useEffect(() => {
    if (fetcher.data && typeof fetcher.data === "object" && "error" in fetcher.data) {
      setError(fetcher.data.error as string);
    } else if (fetcher.state === "idle" && fetcher.data === null && !initialLog) {
      setError("Failed to load log details");
    } else {
      setError(null);
    }
  }, [fetcher.data, initialLog, fetcher.state]);

  const isLoading = fetcher.state === "loading";
  const log = fetcher.data ?? initialLog;

  const runPath = v3RunSpanPath(
    organization,
    project,
    environment,
    { friendlyId: log?.runId ?? "" },
    { spanId: log?.spanId ?? "" }
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.contentEditable === "true"
      )) {
        return;
      }

      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, log, runPath, isLoading]);

  if (isLoading && !log) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!log) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-grid-dimmed p-4">
          <Header2>Log Details</Header2>
          <Button variant="minimal/small" onClick={onClose}>
            <XMarkIcon className="size-5" />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Paragraph className="text-text-dimmed">{error ?? "Log not found"}</Paragraph>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-grid-dimmed px-2 py-2">
        <span
          className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium uppercase tracking-wider",
            getLevelColor(log.level)
          )}
        >
          {log.level}
        </span>
        <Button variant="minimal/small" onClick={onClose} shortcut={{ key: "esc" }}>
          <XMarkIcon className="size-5" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center justify-between border-b border-grid-dimmed px-4">
        <TabContainer>
          <TabButton
            isActive={activeTab === "details"}
            layoutId="log-detail-tabs"
            onClick={() => setActiveTab("details")}
            shortcut={{ key: "d" }}
          >
            Details
          </TabButton>
          <TabButton
            isActive={activeTab === "run"}
            layoutId="log-detail-tabs"
            onClick={() => setActiveTab("run")}
            shortcut={{ key: "r" }}
          >
            Run
          </TabButton>
        </TabContainer>
        <Link to={runPath} target="_blank" rel="noopener noreferrer">
          <Button variant="minimal/small" LeadingIcon={ArrowTopRightOnSquareIcon} shortcut={{ key: "v" }}>
            View full run
          </Button>
        </Link>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "details" && (
          <DetailsTab log={log} runPath={runPath} searchTerm={searchTerm} />
        )}
        {activeTab === "run" && (
          <RunTab log={log} runPath={runPath} />
        )}
      </div>
    </div>
  );
}

function DetailsTab({ log, runPath, searchTerm }: { log: LogEntry; runPath: string; searchTerm?: string }) {
  const logWithExtras = log as LogEntry & {
    attributes?: LogAttributes;
  };


  let beautifiedAttributes: string | null = null;

  if (logWithExtras.attributes) {
    beautifiedAttributes = JSON.stringify(logWithExtras.attributes, null, 2);
    beautifiedAttributes = formatStringJSON(beautifiedAttributes);
  }

  const showAttributes = beautifiedAttributes && beautifiedAttributes !== "{}";

  // Determine message to show
  let message = log.message ?? "";
  if (log.level === "ERROR") {
    const maybeErrorMessage = logWithExtras.attributes?.error?.message;
    if (typeof maybeErrorMessage === "string" && maybeErrorMessage.length > 0) {
      message = maybeErrorMessage;
    }
  }

  return (
    <>
      {/* Time */}
      <div className="mb-6">
        <Header3 className="mb-2">Timestamp</Header3>
        <div className="text-sm text-text-dimmed">
          <DateTimeAccurate date={log.startTime} />
        </div>
      </div>

      {/* Message */}
      <div className="mb-6">
        <PacketDisplay
          data={message}
          dataType="application/json"
          title="Message"
          searchTerm={searchTerm}
        />
      </div>

      {/* Attributes - only available in full log detail */}
      {showAttributes && beautifiedAttributes && (
        <div className="mb-6">
          <PacketDisplay
            data={beautifiedAttributes}
            dataType="application/json"
            title="Attributes"
            searchTerm={searchTerm}
          />
        </div>
      )}
    </>
  );
}

function RunTab({ log, runPath }: { log: LogEntry; runPath: string }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<RunContextData>();

  // Fetch run details when tab is active
  useEffect(() => {
    if (!log.runId) return;

    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/logs/${encodeURIComponent(log.id)}/run?runId=${encodeURIComponent(log.runId)}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization.slug, project.slug, environment.slug, log.id, log.runId]);

  const isLoading = fetcher.state === "loading";
  const runData = fetcher.data?.run;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (!runData) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <Paragraph className="text-text-dimmed">Run not found in database.</Paragraph>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-3">
      <Property.Table>
        <Property.Item>
          <Property.Label>Run ID</Property.Label>
          <Property.Value>
            <CopyableText value={runData.friendlyId} copyValue={runData.friendlyId} asChild />
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Status</Property.Label>
          <Property.Value>
            <SimpleTooltip
              button={<TaskRunStatusCombo status={runData.status as TaskRunStatus} />}
              content={descriptionForTaskRunStatus(runData.status as TaskRunStatus)}
              disableHoverableContent
            />
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Task</Property.Label>
          <Property.Value>
            <CopyableText
              value={runData.taskIdentifier}
              copyValue={runData.taskIdentifier}
              asChild
            />
          </Property.Value>
        </Property.Item>

        {runData.rootRun && (
          <Property.Item>
            <Property.Label>Root and parent run</Property.Label>
            <Property.Value>
              <CopyableText
                value={runData.rootRun.taskIdentifier}
                copyValue={runData.rootRun.taskIdentifier}
                asChild
              />
            </Property.Value>
          </Property.Item>
        )}

        {runData.batch && (
          <Property.Item>
            <Property.Label>Batch</Property.Label>
            <Property.Value>
              <CopyableText
                value={runData.batch.friendlyId}
                copyValue={runData.batch.friendlyId}
                asChild
              />
            </Property.Value>
          </Property.Item>
        )}

        <Property.Item>
          <Property.Label>Version</Property.Label>
          <Property.Value>
            {runData.version ? (
              environment.type === "DEVELOPMENT" ? (
                <CopyableText value={runData.version} copyValue={runData.version} asChild />
              ) : (
                <SimpleTooltip
                  button={
                    <TextLink
                      to={v3DeploymentVersionPath(
                        organization,
                        project,
                        environment,
                        runData.version
                      )}
                      className="group flex flex-wrap items-center gap-x-1 gap-y-0"
                    >
                      <CopyableText value={runData.version} copyValue={runData.version} asChild />
                    </TextLink>
                  }
                  content={"Jump to deployment"}
                />
              )
            ) : (
              <span className="flex items-center gap-1">
                <span>Never started</span>
                <InfoIconTooltip
                  content={"Runs get locked to the latest version when they start."}
                  contentClassName="normal-case tracking-normal"
                />
              </span>
            )}
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Test run</Property.Label>
          <Property.Value>
            {runData.isTest ? <CheckIcon className="size-4 text-text-dimmed" /> : "–"}
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Environment</Property.Label>
          <Property.Value>
            <EnvironmentCombo environment={environment} />
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Queue</Property.Label>
          <Property.Value>
            <div>Name: {runData.queue}</div>
            <div>Concurrency key: {runData.concurrencyKey ? runData.concurrencyKey : "–"}</div>
          </Property.Value>
        </Property.Item>

        {runData.tags && runData.tags.length > 0 && (
          <Property.Item>
            <Property.Label>Tags</Property.Label>
            <Property.Value>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                {runData.tags.map((tag: string) => (
                  <RunTag
                    key={tag}
                    tag={tag}
                    to={v3RunsPath(organization, project, environment, { tags: [tag] })}
                    tooltip={`Filter runs by ${tag}`}
                  />
                ))}
              </div>
            </Property.Value>
          </Property.Item>
        )}

        <Property.Item>
          <Property.Label>Machine</Property.Label>
          <Property.Value className="-ml-0.5">
            {runData.machinePreset ? (
              <MachineLabelCombo preset={runData.machinePreset as MachinePresetName} />
            ) : (
              "–"
            )}
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Run invocation cost</Property.Label>
          <Property.Value>
            {runData.baseCostInCents > 0
              ? formatCurrencyAccurate(runData.baseCostInCents / 100)
              : "–"}
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Compute cost</Property.Label>
          <Property.Value>
            {runData.costInCents > 0 ? formatCurrencyAccurate(runData.costInCents / 100) : "–"}
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Total cost</Property.Label>
          <Property.Value>
            {runData.costInCents > 0 || runData.baseCostInCents > 0
              ? formatCurrencyAccurate((runData.baseCostInCents + runData.costInCents) / 100)
              : "–"}
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Usage duration</Property.Label>
          <Property.Value>
            {runData.usageDurationMs > 0
              ? formatDurationMilliseconds(runData.usageDurationMs, { style: "short" })
              : "–"}
          </Property.Value>
        </Property.Item>
      </Property.Table>
    </div>
  );
}

