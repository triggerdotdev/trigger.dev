import { useEffect, useState, useRef, useCallback } from "react";
import { Clipboard, ClipboardCheck, ChevronDown, ChevronUp } from "lucide-react";
import { MoveToBottomIcon } from "~/assets/icons/MoveToBottomIcon";
import { MoveToTopIcon } from "~/assets/icons/MoveToTopIcon";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { useFollowScroll } from "~/hooks/useFollowScroll";
import type { DeploymentLogEntry } from "~/components/runs/v3/deploymentLogsCache";

export function OnboardingDeploymentLogs({
  logs,
  isStreaming,
  streamError,
  initialCollapsed = false,
  compact = false,
}: {
  logs: readonly DeploymentLogEntry[];
  isStreaming: boolean;
  streamError: string | null;
  initialCollapsed?: boolean;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [mouseOver, setMouseOver] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom, scrollToTop } = useFollowScroll(logsContainerRef, logs);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/no-deriving-state-in-effects -- Deployment status changes intentionally reset the user-controlled collapse state.
    setCollapsed(initialCollapsed);
  }, [initialCollapsed]);

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
    <div
      className={cn(!compact && "mt-1.5", "overflow-hidden rounded-md border border-grid-bright")}
    >
      <div className="flex items-center justify-between border-b border-grid-dimmed px-3 py-2">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                "h-2 w-2 rounded-full",
                errorCount > 0 ? "bg-error/80" : "bg-surface-control"
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
                warningCount > 0 ? "bg-warning/80" : "bg-surface-control"
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
              <Tooltip disableHoverableContent>
                <TooltipTrigger
                  aria-label={isAtBottom ? "Scroll to top" : "Scroll to bottom"}
                  onClick={isAtBottom ? scrollToTop : scrollToBottom}
                  className={cn(
                    "transition-colors duration-100 focus-custom hover:cursor-pointer",
                    "text-text-dimmed hover:text-text-bright"
                  )}
                >
                  {isAtBottom ? (
                    <MoveToTopIcon className="size-4" />
                  ) : (
                    <MoveToBottomIcon className="size-4" />
                  )}
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">
                  {isAtBottom ? "Scroll to top" : "Scroll to bottom"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip open={copied || mouseOver} disableHoverableContent>
                <TooltipTrigger
                  aria-label="Copy logs"
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
                  aria-label={collapsed ? "Expand logs" : "Collapse logs"}
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

      {streamError && (
        <p role="status" className="border-b border-grid-dimmed px-3 py-2 text-xs text-warning">
          {streamError}
        </p>
      )}
      <div className="relative">
        <div
          ref={logsContainerRef}
          className={cn(
            "grow overflow-x-auto overflow-y-scroll font-mono text-xs transition-all duration-200 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
            collapsed ? "h-16" : compact ? "h-48" : "h-64"
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
                    "flex w-full items-center gap-x-2.5 border-l-2 px-2.5 py-1",
                    log.level === "error" && "border-error/60 bg-error/15 hover:bg-error/25",
                    log.level === "warn" && "border-warning/60 bg-warning/20 hover:bg-warning/30",
                    log.level === "info" && "border-transparent hover:bg-background-hover"
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
                  {(log.level === "error" || log.level === "warn") && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        log.level === "error" ? "bg-error" : "bg-warning"
                      )}
                    />
                  )}
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
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-linear-to-t from-background-bright/90 to-transparent" />
        )}
      </div>
    </div>
  );
}
