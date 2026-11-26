import {
  ArrowDownTrayIcon,
  ExclamationCircleIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/20/solid";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import { MoveToBottomIcon } from "~/assets/icons/MoveToBottomIcon";
import { MoveToTopIcon } from "~/assets/icons/MoveToTopIcon";
import { TextInlineIcon } from "~/assets/icons/TextInlineIcon";
import { TextWrapIcon } from "~/assets/icons/TextWrapIcon";
import { Button } from "~/components/primitives/Buttons";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Input } from "~/components/primitives/Input";
import type { DeploymentLogEntry } from "~/components/runs/v3/deploymentLogsCache";
import { useCopy } from "~/hooks/useCopy";
import { useFollowScroll } from "~/hooks/useFollowScroll";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";

/**
 * Build logs filling a tab: a toolbar (error and warning counts that jump to the first one,
 * search, wrap, copy, download, scroll) over numbered lines that run edge to edge. Lines keep the
 * deployment page's log styling.
 */
export function BuildLogsViewer({
  logs,
  isStreaming = false,
  streamError = null,
  downloadName,
}: {
  logs: readonly DeploymentLogEntry[];
  isStreaming?: boolean;
  streamError?: string | null;
  /** File name for Download, e.g. `20261117.4-build.log`. */
  downloadName: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);
  const [focusedLine, setFocusedLine] = useState<number | null>(null);
  const { isAtBottom, scrollToBottom, scrollToTop } = useFollowScroll(containerRef, logs);

  const text = useMemo(
    () =>
      logs
        .map((log) => `${log.timestamp.toISOString()} ${log.level.toUpperCase()} ${log.message}`)
        .join("\n"),
    [logs]
  );
  const { copy, copied } = useCopy(text);

  const needle = query.trim().toLowerCase();
  const lines = logs
    .map((log, index) => ({ log, number: index + 1 }))
    .filter(({ log }) => needle === "" || log.message.toLowerCase().includes(needle));
  const firstError = logs.findIndex((log) => log.level === "error");
  const firstWarning = logs.findIndex((log) => log.level === "warn");
  const errorCount = logs.filter((log) => log.level === "error").length;
  const warningCount = logs.filter((log) => log.level === "warn").length;

  const jumpTo = (index: number) => {
    if (index < 0) return;
    setQuery("");
    setFocusedLine(index + 1);
    // After the filter clears, the line is in the DOM.
    requestAnimationFrame(() =>
      containerRef.current
        ?.querySelector(`[data-line="${index + 1}"]`)
        ?.scrollIntoView({ block: "center" })
    );
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadName;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex min-h-10 flex-none items-center justify-between gap-2 border-b border-grid-bright px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <CountJump
            count={errorCount}
            noun="error"
            dotClassName="bg-error"
            textClassName="text-error"
            onJump={() => jumpTo(firstError)}
          />
          <CountJump
            count={warningCount}
            noun="warning"
            dotClassName="bg-warning"
            textClassName="text-warning"
            onJump={() => jumpTo(firstWarning)}
          />
          <div className="ml-2 w-56">
            <Input
              variant="small"
              icon={MagnifyingGlassIcon}
              placeholder="Search logs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              accessory={
                needle ? (
                  <span className="text-[0.6875rem] tabular-nums text-text-faint">
                    {formatNumber(lines.length)}
                  </span>
                ) : undefined
              }
            />
          </div>
        </div>
        <div className="flex flex-none items-center gap-0.5">
          <ToolButton label={wrap ? "Unwrap lines" : "Wrap lines"} onClick={() => setWrap(!wrap)}>
            {wrap ? <TextInlineIcon className="size-4" /> : <TextWrapIcon className="size-4" />}
          </ToolButton>
          <ToolButton label={copied ? "Copied" : "Copy logs"} onClick={copy} active={copied}>
            {copied ? <ClipboardCheck className="size-4" /> : <Clipboard className="size-4" />}
          </ToolButton>
          <ToolButton label="Download" onClick={download}>
            <ArrowDownTrayIcon className="size-4" />
          </ToolButton>
          <ToolButton
            label={isAtBottom ? "Scroll to top" : "Scroll to bottom"}
            onClick={isAtBottom ? scrollToTop : scrollToBottom}
          >
            {isAtBottom ? (
              <MoveToTopIcon className="size-4" />
            ) : (
              <MoveToBottomIcon className="size-4" />
            )}
          </ToolButton>
        </div>
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
      >
        <div className={cn("flex flex-col py-1", wrap ? "w-full" : "w-fit min-w-full")}>
          {lines.length === 0 ? (
            <div className="px-3 py-1">
              {streamError ? (
                <span className="text-error">Couldn't load the build logs: {streamError}</span>
              ) : needle ? (
                <span className="text-text-dimmed">No lines match "{query.trim()}"</span>
              ) : (
                <span className="text-text-dimmed">
                  {isStreaming ? "Waiting for logs…" : "No logs yet"}
                </span>
              )}
            </div>
          ) : null}
          {lines.map(({ log, number }) => (
            <div
              key={number}
              data-line={number}
              className={cn(
                "grid grid-cols-[3rem_auto_minmax(0,1fr)] gap-x-3 border-l-2 py-0.5 pr-3",
                log.level === "error" && "border-error/60 bg-error/15 hover:bg-error/25",
                log.level === "warn" && "border-warning/60 bg-warning/20 hover:bg-warning/30",
                (log.level === "info" || log.level === "debug") &&
                  "border-transparent hover:bg-background-hover",
                focusedLine === number && "outline outline-1 -outline-offset-1 outline-text-dimmed"
              )}
            >
              <span className="select-none text-right tabular-nums text-text-faint">{number}</span>
              <span
                className={cn(
                  "select-none whitespace-nowrap",
                  log.level === "error"
                    ? "text-error/80"
                    : log.level === "warn"
                      ? "text-warning/70"
                      : "text-text-dimmed"
                )}
              >
                <DateTimeAccurate date={log.timestamp} hideDate hour12={false} />
              </span>
              <span
                className={cn(
                  wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
                  log.level === "error"
                    ? "text-error"
                    : log.level === "warn"
                      ? "text-warning"
                      : "text-text-bright"
                )}
              >
                <Highlight text={log.message} needle={needle} />
              </span>
            </div>
          ))}
          {isStreaming && lines.length > 0 ? (
            <div className="px-3 py-1 pl-[4.25rem] text-text-faint">Streaming…</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** "2 errors" with a dot; clicking it scrolls to the first one. */
function CountJump({
  count,
  noun,
  dotClassName,
  textClassName,
  onJump,
}: {
  count: number;
  noun: string;
  dotClassName: string;
  textClassName: string;
  onJump: () => void;
}) {
  return (
    <Button
      variant="minimal/small"
      disabled={count === 0}
      onClick={onJump}
      tooltip={count > 0 ? `Jump to the first ${noun}` : undefined}
      LeadingIcon={
        count > 0 ? (
          <ExclamationCircleIcon className={cn("size-3.5", textClassName)} />
        ) : (
          <span className={cn("mx-1 size-1.5 rounded-full opacity-40", dotClassName)} />
        )
      }
    >
      <span className={cn("tabular-nums", count > 0 ? textClassName : "text-text-faint")}>
        {formatNumber(count)} {count === 1 ? noun : `${noun}s`}
      </span>
    </Button>
  );
}

function ToolButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="minimal/small"
      onClick={onClick}
      tooltip={label}
      aria-label={label}
      className={cn("px-1.5", active ? "text-success" : "text-text-dimmed")}
    >
      {children}
    </Button>
  );
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  parts.push({ text: text.slice(from), match: false });
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-sm bg-warning/40 text-text-bright">
            {part.text}
          </mark>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        )
      )}
    </>
  );
}
