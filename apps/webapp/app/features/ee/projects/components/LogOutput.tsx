import type { DeploymentLog } from ".prisma/client";
import classNames from "classnames";
import { LogDate } from "~/components/IntlDate";
import { TertiaryLink } from "~/components/primitives/Buttons";

export function LogOutput({ logs }: { logs: DeploymentLog[] }) {
  return (
    <pre className="grid max-h-[50px] w-full grid-cols-[repeat(3,_fit-content(800px))_1fr] items-start gap-y-1 gap-x-4 text-sm text-slate-300">
      {logs.map((log) => (
        <LogItem key={log.id} log={log} />
      ))}
    </pre>
  );
}

function LogItem({ log }: { log: DeploymentLog }) {
  const parsedMessage = parseLogForTriggerDevLink(log.log);
  const logLevel = parseLogLevel(log);

  return (
    <>
      <span>
        <LogDate date={log.createdAt} />
      </span>
      <span
        className={classNames(
          logLevel === "error"
            ? "text-rose-500"
            : logLevel === "warn"
            ? "text-amber-500"
            : ""
        )}
      >
        {logLevel}
      </span>
      <span>{parsedMessage.log}</span>
      {parsedMessage.action ? (
        <TertiaryLink
          to={parsedMessage.action.url}
          className="sticky -right-4 justify-self-end bg-slate-950 px-3.5"
        >
          {parsedMessage.action.text}
        </TertiaryLink>
      ) : (
        <span></span>
      )}
    </>
  );
}

function parseLogLevel(log: DeploymentLog): string {
  // If the log.log has a red flag emoji in it, it's an error
  if (log.log.includes("🚨") || log.log.includes("🚩")) {
    return "error";
  }

  return log.level;
}

function parseLogForTriggerDevLink(log: string): {
  log: string;
  action?: { url: string; text: string };
} {
  const runStartedRegex =
    /^\[\w+\.\w+\]\s+Run\s+(\w+)\s+started\s+👉\s+View\s+on\s+dashboard:\s+\((\S+)\)\s+\[([^\]]+)\]/;
  const runCompleteRegex =
    /^\[\w+\.\w+\]\s+Run\s+(\w+)\s+complete\s+👉\s+View\s+on\s+dashboard:\s+\((\S+)\)\s+\[([^\]]+)\]/;
  const connectedRegex =
    /^\[\w+\.\w+\]\s+✨\s+Connected\s+and\s+listening\s+for\s+events\s+👉\s+View\s+on\s+dashboard:\s+\((\S+)\)\s+\[([^\]]+)\]/;

  const runStartedMatch = log.match(runStartedRegex);

  if (runStartedMatch) {
    const [, id, url, workflowSlug] = runStartedMatch;

    const log = `[trigger.dev] Run ${id} started [${workflowSlug}]`;

    return {
      log,
      action: { url: getUrlPath(url), text: "View" },
    };
  }

  const runCompleteMatch = log.match(runCompleteRegex);

  if (runCompleteMatch) {
    const [, id, url, workflowSlug] = runCompleteMatch;

    const log = `[trigger.dev] Run ${id} complete [${workflowSlug}]`;

    return {
      log,
      action: { url: getUrlPath(url), text: "View" },
    };
  }

  const connectedMatch = log.match(connectedRegex);

  if (connectedMatch) {
    const [, url, workflowSlug] = connectedMatch;

    const log = `[trigger.dev] ✨ Connected and listening for events [${workflowSlug}]`;

    return {
      log,
      action: { url: getUrlPath(url), text: "View" },
    };
  }

  return {
    log,
  };
}

function getUrlPath(url: string) {
  const urlObj = new URL(url);
  return urlObj.pathname;
}
