import { XMarkIcon } from "@heroicons/react/20/solid";
import type { TaskRunStatus } from "@trigger.dev/database";
import { useEffect, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { PacketDisplay } from "~/components/runs/v3/PacketDisplay";
import {
  TaskRunStatusCombo,
  descriptionForTaskRunStatus,
} from "~/components/runs/v3/TaskRunStatus";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import type { loader as logDetailLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs.$logId";
import { cn } from "~/utils/cn";
import { getLevelColor } from "~/utils/logUtils";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import { LogLevel } from "./LogLevel";
import { ExitIcon } from "~/assets/icons/ExitIcon";
type LogDetailViewProps = {
  logId: string;
  // If we have the log entry from the list, we can display it immediately
  initialLog?: LogEntry;
  onClose: () => void;
  searchTerm?: string;
};

type LogAttributes = Record<string, unknown> & {
  error?: {
    message?: string;
  };
};

function getDisplayMessage(log: {
  message: string;
  level: string;
  attributes?: LogAttributes;
}): string {
  let message = log.message ?? "";
  if (log.level === "ERROR") {
    const maybeErrorMessage = log.attributes?.error?.message;
    if (typeof maybeErrorMessage === "string" && maybeErrorMessage.length > 0) {
      message = maybeErrorMessage;
    }
  }
  return message;
}

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
  const [error, setError] = useState<string | null>(null);

  // Fetch full log details when logId changes
  useEffect(() => {
    if (!logId) return;

    setError(null);
    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
        environment.slug
      }/logs/${encodeURIComponent(logId)}`
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
  const runStatus = fetcher.data?.runStatus;

  const runPath = v3RunSpanPath(
    organization,
    project,
    environment,
    { friendlyId: log?.runId ?? "" },
    { spanId: log?.spanId ?? "" }
  );

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
        <div className="flex items-center justify-between border-b border-grid-dimmed py-2 pl-3 pr-2">
          <Header2>Log Details</Header2>
          <Button
            onClick={onClose}
            variant="minimal/small"
            TrailingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
            shortcutPosition="before-trailing-icon"
            className="pl-1"
          />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Paragraph className="text-text-dimmed">{error ?? "Log not found"}</Paragraph>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between overflow-hidden border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2 className="truncate">{getDisplayMessage(log)}</Header2>
        <Button
          onClick={onClose}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <DetailsTab log={log} runPath={runPath} runStatus={runStatus} searchTerm={searchTerm} />
      </div>
    </div>
  );
}

function DetailsTab({
  log,
  runPath,
  runStatus,
  searchTerm,
}: {
  log: LogEntry & {
    attributes?: LogAttributes;
  };
  runPath: string;
  runStatus?: TaskRunStatus;
  searchTerm?: string;
}) {
  let beautifiedAttributes: string | null = null;

  if (log.attributes) {
    beautifiedAttributes = JSON.stringify(log.attributes, null, 2);
    beautifiedAttributes = formatStringJSON(beautifiedAttributes);
  }

  const showAttributes = beautifiedAttributes && beautifiedAttributes !== "{}";

  const message = getDisplayMessage(log);

  return (
    <>
      <Property.Table>
        <Property.Item>
          <Property.Label>Run ID</Property.Label>
          <Property.Value>
            <CopyableText value={log.runId} copyValue={log.runId} asChild />
            <LinkButton
              to={runPath}
              variant="secondary/small"
              shortcut={{ key: "v" }}
              className="mt-2"
            >
              View full run
            </LinkButton>
          </Property.Value>
        </Property.Item>

        {runStatus && (
          <Property.Item>
            <Property.Label>Status</Property.Label>
            <Property.Value>
              <SimpleTooltip
                button={<TaskRunStatusCombo status={runStatus} />}
                content={descriptionForTaskRunStatus(runStatus)}
                disableHoverableContent
                className="mt-1"
              />
            </Property.Value>
          </Property.Item>
        )}

        <Property.Item>
          <Property.Label>Task</Property.Label>
          <Property.Value>
            <CopyableText value={log.taskIdentifier} copyValue={log.taskIdentifier} asChild />
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Level</Property.Label>
          <Property.Value>
            <LogLevel level={log.level} />
          </Property.Value>
        </Property.Item>

        <Property.Item>
          <Property.Label>Timestamp</Property.Label>
          <Property.Value>
            <DateTimeAccurate date={log.triggeredTimestamp} />
          </Property.Value>
        </Property.Item>
      </Property.Table>

      {/* Message */}
      <div className="mb-6 mt-3">
        <PacketDisplay
          data={message}
          dataType="application/json"
          title="Message"
          searchTerm={searchTerm}
          wrap={true}
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
