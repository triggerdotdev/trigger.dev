import { Link, useLocation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEffect, useState, useRef, useCallback } from "react";
import { S2, S2Error } from "@s2-dev/streamstore";
import { Clipboard, ClipboardCheck, ChevronDown, ChevronUp } from "lucide-react";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { GitMetadata } from "~/components/GitMetadata";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { DeploymentError } from "~/components/runs/v3/DeploymentError";
import { DeploymentStatus } from "~/components/runs/v3/DeploymentStatus";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3DeploymentParams, v3DeploymentsPath, v3RunsPath } from "~/utils/pathBuilder";
import { capitalizeWord } from "~/utils/string";
import { UserTag } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments/route";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, deploymentParam } =
    v3DeploymentParams.parse(params);

  try {
    const presenter = new DeploymentPresenter();
    const { deployment, s2Logs } = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
      environmentSlug: envParam,
      deploymentShortCode: deploymentParam,
    });

    return typedjson({ deployment, s2Logs });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

type LogEntry = {
  message: string;
  timestamp: Date;
  level: "info" | "error" | "warn";
};

export default function Page() {
  const { deployment, s2Logs } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const page = new URLSearchParams(location.search).get("page");

  const logsDisabled = s2Logs === undefined;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    if (logsDisabled) return;

    const abortController = new AbortController();

    setLogs([]);
    setStreamError(null);
    setIsStreaming(true);

    const streamLogs = async () => {
      try {
        const s2 = new S2({ accessToken: s2Logs.accessToken });
        const basin = s2.basin(s2Logs.basin);
        const stream = basin.stream(s2Logs.stream);

        const readSession = await stream.readSession(
          {
            seq_num: 0,
            wait: 60,
            as: "bytes",
          },
          { signal: abortController.signal }
        );

        const decoder = new TextDecoder();

        for await (const record of readSession) {
          try {
            const headers: Record<string, string> = {};

            if (record.headers) {
              for (const [nameBytes, valueBytes] of record.headers) {
                headers[decoder.decode(nameBytes)] = decoder.decode(valueBytes);
              }
            }
            const level = (headers["level"]?.toLowerCase() as LogEntry["level"]) ?? "info";

            setLogs((prevLogs) => [
              ...prevLogs,
              {
                timestamp: new Date(record.timestamp),
                message: decoder.decode(record.body),
                level,
              },
            ]);
          } catch (err) {
            console.error("Failed to parse log record:", err);
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) return;

        const isNotFoundError =
          error instanceof S2Error &&
          error.code &&
          ["permission_denied", "stream_not_found"].includes(error.code);
        if (isNotFoundError) return;

        console.error("Failed to stream logs:", error);
        setStreamError("Failed to stream logs");
      } finally {
        if (!abortController.signal.aborted) {
          setIsStreaming(false);
        }
      }
    };

    streamLogs();

    return () => {
      abortController.abort();
    };
  }, [s2Logs?.basin, s2Logs?.stream, s2Logs?.accessToken]);

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>Deploy: {deployment.shortCode}</Header2>

        <AdminDebugTooltip>
          <Property.Table>
            <Property.Item>
              <Property.Label>ID</Property.Label>
              <Property.Value>{deployment.id}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Project ID</Property.Label>
              <Property.Value>{deployment.projectId}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Org ID</Property.Label>
              <Property.Value>{deployment.organizationId}</Property.Value>
            </Property.Item>
            {deployment.imageReference && (
              <Property.Item>
                <Property.Label>Image</Property.Label>
                <Property.Value>{deployment.imageReference}</Property.Value>
              </Property.Item>
            )}
            <Property.Item>
              <Property.Label>Platform</Property.Label>
              <Property.Value>{deployment.imagePlatform}</Property.Value>
            </Property.Item>
            {deployment.externalBuildData && (
              <Property.Item>
                <Property.Label>Build Server</Property.Label>
                <Property.Value>
                  <Link
                    to={`/resources/${deployment.projectId}/deployments/${deployment.id}/logs`}
                    className="extra-small/bright/mono underline"
                  >
                    {deployment.externalBuildData.buildId}
                  </Link>
                </Property.Value>
              </Property.Item>
            )}
          </Property.Table>
        </AdminDebugTooltip>

        <LinkButton
          to={`${v3DeploymentsPath(organization, project, environment)}${
            page ? `?page=${page}` : ""
          }`}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col">
          <div className="p-3">
            <Property.Table>
              <Property.Item>
                <Property.Label>Deploy</Property.Label>
                <Property.Value className="flex items-center gap-2">
                  <span>{deployment.shortCode}</span>
                  {deployment.label && (
                    <Badge variant="extra-small" className="capitalize">
                      {deployment.label}
                    </Badge>
                  )}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Environment</Property.Label>
                <Property.Value>
                  <EnvironmentCombo environment={deployment.environment} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Version</Property.Label>
                <Property.Value>{deployment.version}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Status</Property.Label>
                <Property.Value>
                  <DeploymentStatus
                    status={deployment.status}
                    isBuilt={deployment.isBuilt}
                    className="text-sm"
                  />
                </Property.Value>
              </Property.Item>
              {!logsDisabled && (
                <Property.Item>
                  <Property.Label>Logs</Property.Label>
                  <LogsDisplay
                    logs={logs}
                    isStreaming={isStreaming}
                    streamError={streamError}
                    initialCollapsed={(
                      ["PENDING", "DEPLOYED", "TIMED_OUT"] satisfies (typeof deployment.status)[]
                    ).includes(deployment.status)}
                  />
                </Property.Item>
              )}
              {deployment.canceledAt && (
                <Property.Item>
                  <Property.Label>Canceled at</Property.Label>
                  <Property.Value>
                    <>
                      <DateTimeAccurate date={deployment.canceledAt} /> UTC
                    </>
                  </Property.Value>
                </Property.Item>
              )}
              {deployment.canceledReason && (
                <Property.Item>
                  <Property.Label>Cancelation reason</Property.Label>
                  <Property.Value>{deployment.canceledReason}</Property.Value>
                </Property.Item>
              )}
              <Property.Item>
                <Property.Label>Tasks</Property.Label>
                <Property.Value>{deployment.tasks ? deployment.tasks.length : "–"}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>SDK Version</Property.Label>
                <Property.Value>
                  {deployment.sdkVersion ? deployment.sdkVersion : "–"}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>CLI Version</Property.Label>
                <Property.Value>
                  {deployment.cliVersion ? deployment.cliVersion : "–"}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Runtime</Property.Label>
                <Property.Value>
                  <RuntimeIcon
                    runtime={deployment.runtime}
                    runtimeVersion={deployment.runtimeVersion}
                    withLabel
                  />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Worker type</Property.Label>
                <Property.Value>{capitalizeWord(deployment.type)}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Started at</Property.Label>
                <Property.Value>
                  {deployment.startedAt ? (
                    <>
                      <DateTimeAccurate date={deployment.startedAt} /> UTC
                    </>
                  ) : (
                    "–"
                  )}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Installed at</Property.Label>
                <Property.Value>
                  {deployment.installedAt ? (
                    <>
                      <DateTimeAccurate date={deployment.installedAt} /> UTC
                    </>
                  ) : (
                    "–"
                  )}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Built at</Property.Label>
                <Property.Value>
                  {deployment.builtAt ? (
                    <>
                      <DateTimeAccurate date={deployment.builtAt} /> UTC
                    </>
                  ) : (
                    "–"
                  )}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Deployed at</Property.Label>
                <Property.Value>
                  {deployment.deployedAt ? (
                    <>
                      <DateTimeAccurate date={deployment.deployedAt} /> UTC
                    </>
                  ) : (
                    "–"
                  )}
                </Property.Value>
              </Property.Item>

              <Property.Item>
                <Property.Label>Git</Property.Label>
                <Property.Value>
                  <div className="-ml-1 mt-0.5 flex flex-col">
                    <GitMetadata git={deployment.git} />
                  </div>
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Deployed by</Property.Label>
                <Property.Value>
                  {deployment.git?.source === "trigger_github_app" ? (
                    <UserTag
                      name={deployment.git.ghUsername ?? "GitHub Integration"}
                      avatarUrl={deployment.git.ghUserAvatarUrl}
                    />
                  ) : deployment.deployedBy ? (
                    <UserTag
                      name={deployment.deployedBy.name ?? deployment.deployedBy.displayName ?? ""}
                      avatarUrl={deployment.deployedBy.avatarUrl ?? undefined}
                    />
                  ) : (
                    "–"
                  )}
                </Property.Value>
              </Property.Item>
            </Property.Table>
          </div>

          {deployment.errorData && <DeploymentError errorData={deployment.errorData} />}

          {deployment.tasks && (
            <div className="divide-y divide-charcoal-800 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
              <Table variant="bright">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className="px-2">Task</TableHeaderCell>
                    <TableHeaderCell className="px-2">File path</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deployment.tasks.map((t) => {
                    const path = v3RunsPath(organization, project, environment, {
                      tasks: [t.slug],
                    });
                    return (
                      <TableRow key={t.slug}>
                        <TableCell to={path}>
                          <div className="inline-flex flex-col gap-0.5">
                            <Paragraph variant="extra-small" className="text-text-dimmed">
                              {t.slug}
                            </Paragraph>
                          </div>
                        </TableCell>
                        <TableCell to={path}>{t.filePath}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LogsDisplay({
  logs,
  isStreaming,
  streamError,
  initialCollapsed = false,
}: {
  logs: LogEntry[];
  isStreaming: boolean;
  streamError: string | null;
  initialCollapsed?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [mouseOver, setMouseOver] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCollapsed(initialCollapsed);
  }, [initialCollapsed]);

  // auto-scroll log container to bottom when new logs arrive
  useEffect(() => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const onCopyLogs = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const logsText = logs.map((log) => log.message).join("\n");
      navigator.clipboard.writeText(logsText);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    },
    [logs]
  );

  const errorCount = logs.filter((log) => log.level === "error").length;
  const warningCount = logs.filter((log) => log.level === "warn").length;

  return (
    <div className="mt-1.5 overflow-hidden rounded-md border border-grid-bright">
      <div className="flex items-center justify-between border-b border-grid-dimmed px-3 py-2">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                "h-2 w-2 rounded-full",
                errorCount > 0 ? "bg-error/80" : "bg-charcoal-600"
              )}
            />
            <Paragraph variant="extra-small/dimmed/mono" className="w-[ch-10]">
              {`${errorCount} ${errorCount === 1 ? "error" : "errors"}`}
            </Paragraph>
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                "h-2 w-2 rounded-full",
                warningCount > 0 ? "bg-warning/80" : "bg-charcoal-600"
              )}
            />
            <Paragraph variant="extra-small/dimmed/mono">
              {`${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`}
            </Paragraph>
          </div>
        </div>
        {logs.length > 0 && (
          <div className="flex items-center gap-3">
            <TooltipProvider>
              <Tooltip open={copied || mouseOver} disableHoverableContent>
                <TooltipTrigger
                  onClick={onCopyLogs}
                  onMouseEnter={() => setMouseOver(true)}
                  onMouseLeave={() => setMouseOver(false)}
                  className={cn(
                    "transition-colors duration-100 focus-custom hover:cursor-pointer",
                    copied ? "text-success" : "text-text-dimmed hover:text-text-bright"
                  )}
                >
                  <div className="size-4 shrink-0">
                    {copied ? (
                      <ClipboardCheck className="size-full" />
                    ) : (
                      <Clipboard className="size-full" />
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">
                  {copied ? "Copied" : "Copy"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip disableHoverableContent>
                <TooltipTrigger
                  onClick={() => setCollapsed(!collapsed)}
                  className={cn(
                    "transition-colors duration-100 focus-custom hover:cursor-pointer",
                    "text-text-dimmed hover:text-text-bright"
                  )}
                >
                  {collapsed ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronUp className="size-4" />
                  )}
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">
                  {collapsed ? "Expand" : "Collapse"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
      </div>

      <div className="relative">
        <div
          ref={logsContainerRef}
          className={cn(
            "grow overflow-x-auto overflow-y-scroll font-mono text-xs transition-all duration-200 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600",
            collapsed ? "h-16" : "h-64"
          )}
        >
          <div className="flex w-fit min-w-full flex-col">
            {logs.length === 0 && (
              <div className="flex gap-x-2.5 border-l-2 border-transparent px-2.5 py-1">
                {streamError ? (
                  <span className="text-error">Failed fetching logs</span>
                ) : (
                  <span className="text-text-dimmed">
                    {isStreaming ? "Waiting for logs..." : "No logs yet"}
                  </span>
                )}
              </div>
            )}
            {logs.map((log, index) => {
              return (
                <div
                  key={index}
                  className={cn(
                    "flex w-full gap-x-2.5 border-l-2 px-2.5 py-1",
                    log.level === "error" && "border-error/60 bg-error/15 hover:bg-error/25",
                    log.level === "warn" && "border-warning/60 bg-warning/20 hover:bg-warning/30",
                    log.level === "info" && "border-transparent hover:bg-charcoal-750"
                  )}
                >
                  <span
                    className={cn(
                      "select-none whitespace-nowrap py-px",
                      log.level === "error" && "text-error/80",
                      log.level === "warn" && "text-warning/70",
                      log.level === "info" && "text-text-dimmed"
                    )}
                  >
                    <DateTimeAccurate date={log.timestamp} hideDate hour12={false} />
                  </span>
                  <span
                    className={cn(
                      "whitespace-nowrap",
                      log.level === "error" && "text-error",
                      log.level === "warn" && "text-warning",
                      log.level === "info" && "text-text-bright"
                    )}
                  >
                    {log.message}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {collapsed && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-charcoal-800/90 to-transparent" />
        )}
      </div>
    </div>
  );
}
