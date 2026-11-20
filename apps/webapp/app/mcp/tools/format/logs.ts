import { renderCursor, renderDuration, renderLogRow, renderTime, untrusted } from "./logFields";

const LIST_MESSAGE_CHARS = 500;
const DETAIL_CHARS = 4_000;

type LogListEntry = {
  id: string;
  runId: string;
  taskIdentifier: string;
  traceId: string;
  spanId: string;
  triggeredTimestamp: string;
  level: string;
  message: string;
};

type LogsPage = {
  logs: LogListEntry[];
  pagination: { next?: string };
  searchProgress: {
    searchedTo?: string;
    complete: boolean;
    timedOut: boolean;
    stopped: boolean;
    expired: boolean;
  };
  filters: { from: Date; to: Date };
};

export type LogsSearchCall = {
  searchedFrom: Date;
  cursorIgnored: boolean;
  budgetSpent: boolean;
};

function searchedLine(page: LogsPage, call: LogsSearchCall): string | undefined {
  const { complete, searchedTo } = page.searchProgress;
  const from = call.searchedFrom.toISOString();
  if (complete) return `This call searched from ${from} back to the start of the time range.`;
  if (searchedTo) return `This call searched from ${from} back to ${searchedTo}.`;
  return undefined;
}

function continueLine(page: LogsPage, call: LogsSearchCall): string {
  if (page.searchProgress.timedOut) {
    return "The query time limit was hit, so the time range was not fully searched.";
  }
  if (call.budgetSpent) {
    return "No new read was started after this call's time budget, so the page is not full and the time range was not fully searched.";
  }
  return "Older logs may exist.";
}

type LogDetail = Omit<LogListEntry, "triggeredTimestamp"> & {
  startTime: string;
  duration: number;
  rawAttributes: string;
};

export function formatLogsPage(page: LogsPage, call: LogsSearchCall): string {
  const lines: string[] = [];

  if (call.cursorIgnored) {
    lines.push("The cursor did not match these filters; started from the newest logs.");
  }

  if (page.logs.length === 0) {
    lines.push("No logs found on this page.");
  } else {
    lines.push(`Found ${page.logs.length} log${page.logs.length === 1 ? "" : "s"}, newest first:`);
    page.logs.forEach((log, i) => {
      const row = renderLogRow(log, LIST_MESSAGE_CHARS);
      lines.push(
        `${i + 1}. ${renderTime(log.triggeredTimestamp)} | ${row.level} | ${row.task} | ${row.run} | id: ${row.id}`
      );
      lines.push(`   ${row.message}`);
    });
  }

  const next = page.pagination.next;
  if (page.searchProgress.expired) {
    lines.push("The cursor has expired. Search again without a cursor.");
    return lines.join("\n");
  }

  lines.push(
    `Time range: ${page.filters.from.toISOString()} to ${page.filters.to.toISOString()} (UTC).`
  );
  const searched = searchedLine(page, call);
  if (searched) lines.push(searched);

  if (page.searchProgress.stopped) {
    lines.push("The search stopped because it was too slow. Narrow the time range or add filters.");
  } else if (next) {
    const cursor = renderCursor(next);
    lines.push(
      cursor
        ? `Next cursor: ${cursor}\n${continueLine(page, call)} Pass the cursor with the same filters to continue.`
        : `${continueLine(page, call)} The cursor is too large to return. Narrow the filters to continue.`
    );
  }

  return lines.join("\n");
}

export function formatLogDetail(log: LogDetail): string {
  const row = renderLogRow(log, DETAIL_CHARS);
  const lines = [
    `Log ${row.id}`,
    `Level: ${row.level}`,
    `Time: ${renderTime(log.startTime)}`,
    `Task: ${row.task}`,
    `Run: ${row.run}`,
    `Trace: ${row.trace}, span: ${row.span}`,
  ];
  const duration = renderDuration(log.duration);
  if (duration) lines.push(`Duration: ${duration}`);
  lines.push(`Message: ${row.message}`);
  if (log.rawAttributes && log.rawAttributes !== "{}") {
    lines.push(`Attributes: ${untrusted(log.rawAttributes, "log-attributes", DETAIL_CHARS)}`);
  }
  return lines.join("\n");
}
