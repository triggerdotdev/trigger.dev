import { logsSearchPredicate, normalizeLogsSearchTerm } from "./logSearch";

export type LogsSearchAction =
  | "open_result"
  | "load_more"
  | "continue_search"
  | "expand_range"
  | "retry"
  | "cancel"
  | "replace_unfinished_search";

type SearchMetadata = ReturnType<typeof searchMetadata>;
export type LogsSearchEvent = "logs_search_started" | "logs_search_result" | "logs_search_action";
export type LogsSearchCapture = (
  event: LogsSearchEvent,
  properties: Record<string, unknown>
) => void;
export type LogsSearchResponse = {
  resultCount: number;
  complete: boolean;
  timedOut: boolean;
  stopped: boolean;
  expired: boolean;
  queryElapsedMs?: number;
  rangeDurationMs?: number;
};
type SearchOutcome =
  | "results"
  | "no_matches"
  | "timeout"
  | "expired"
  | "budget_exhausted"
  | "error";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function rangeBucket(duration: number) {
  if (!Number.isFinite(duration)) return "unknown";
  if (duration <= 0) return "empty";
  if (duration <= HOUR_MS) return "up_to_1h";
  if (duration <= DAY_MS) return "up_to_1d";
  if (duration <= 7 * DAY_MS) return "up_to_7d";
  return "over_7d";
}

function searchMetadata(params: URLSearchParams) {
  const term = normalizeLogsSearchTerm((params.get("search") ?? "").slice(0, 1000));
  return {
    search_kind: term ? logsSearchPredicate(term).kind : "no_text",
    term_length_bucket: !term
      ? "0"
      : term.length <= 10
        ? "1_10"
        : term.length <= 50
          ? "11_50"
          : "over_50",
    time_range_bucket: "unknown",
    has_level_filter: params.getAll("levels").some(Boolean),
    has_task_filter: params.getAll("tasks").some(Boolean),
    has_run_filter: !!params.get("runId"),
  };
}

// Filter values are used only for local identity, never as event properties.
export function logsSearchKey(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  params.delete("cursor");
  params.delete("log");
  params.sort();
  return `${pathname}?${params.toString()}`;
}

export function isLogsPage(pathname: string) {
  return /^\/orgs\/[^/]+\/projects\/[^/]+\/env\/[^/]+\/logs\/?$/.test(pathname);
}

export class LogsSearchAnalytics {
  private current?: {
    key: string;
    pathname: string;
    id: string;
    startedAt: number;
    timingOrigin: "route_mount" | "route_commit" | "navigation";
    metadata: SearchMetadata;
    resultSent: boolean;
    lastOutcome?: SearchOutcome;
    timeoutCount: number;
    term: string;
    initialResponseSeen: boolean;
  };
  private nextEntryPoint?: "expand_range";

  constructor(
    private readonly capture: LogsSearchCapture,
    private readonly now = () => performance.now(),
    private readonly id = () => crypto.randomUUID()
  ) {}

  start(key: string, search: string, navigationStartedAt?: number) {
    if (this.current?.key === key) return;
    const params = new URLSearchParams(search);
    const term = params.get("search") ?? "";
    const pathname = key.split("?")[0];
    const entryPoint = !this.current
      ? "route_mount"
      : this.current.pathname !== pathname
        ? "context_change"
        : (this.nextEntryPoint ?? (this.current.term !== term ? "new_search" : "filter_change"));
    this.nextEntryPoint = undefined;
    if (this.current && !this.current.resultSent) this.action("replace_unfinished_search");
    this.current = {
      key,
      pathname,
      id: this.id(),
      startedAt: navigationStartedAt ?? this.now(),
      timingOrigin:
        navigationStartedAt !== undefined
          ? "navigation"
          : this.current
            ? "route_commit"
            : "route_mount",
      metadata: searchMetadata(params),
      resultSent: false,
      timeoutCount: 0,
      term,
      initialResponseSeen: false,
    };
    this.emit("logs_search_started", { entry_point: entryPoint });
  }

  response(key: string, response: LogsSearchResponse) {
    const current = this.current;
    if (!current || current.key !== key) return;
    if (response.rangeDurationMs !== undefined)
      current.metadata.time_range_bucket = rangeBucket(response.rangeDurationMs);
    if (!current.initialResponseSeen) {
      current.initialResponseSeen = true;
      // Route mounts/commits lack a navigation start. The initial server query is a lower bound.
      if (current.timingOrigin !== "navigation" && Number.isFinite(response.queryElapsedMs)) {
        current.startedAt = Math.min(
          current.startedAt,
          this.now() - (response.queryElapsedMs ?? 0)
        );
      }
    }
    if (response.timedOut) current.timeoutCount++;
    const outcome = response.stopped
      ? "timeout"
      : response.expired
        ? "expired"
        : response.resultCount > 0
          ? "results"
          : response.complete
            ? "no_matches"
            : undefined;
    if (outcome && (!current.resultSent || response.stopped || response.expired)) {
      this.result(key, outcome, response.resultCount, response.complete);
    }
  }

  result(key: string, outcome: SearchOutcome, resultCount = 0, complete = false) {
    const current = this.current;
    if (!current || current.key !== key) return;
    const phase = current.resultSent ? "continuation" : "initial";
    if (
      phase === "continuation" &&
      (outcome === "results" || outcome === "no_matches" || outcome === current.lastOutcome)
    )
      return;
    current.resultSent = true;
    current.lastOutcome = outcome;
    this.emit("logs_search_result", {
      phase,
      outcome,
      elapsed_ms: Math.round(this.now() - current.startedAt),
      ...(phase === "initial" ? { first_batch_result_count: resultCount } : {}),
      range_complete: complete,
      timeout_count: current.timeoutCount,
    });
  }

  action(action: LogsSearchAction, key = this.current?.key) {
    if (!this.current || this.current.key !== key) return;
    if (action === "expand_range") this.nextEntryPoint = "expand_range";
    if (action === "retry" || action === "continue_search" || action === "load_more")
      this.current.lastOutcome = undefined;
    this.emit("logs_search_action", {
      action,
      elapsed_ms: Math.round(this.now() - this.current.startedAt),
      before_result: !this.current.resultSent,
    });
  }

  leave() {
    if (this.current && !this.current.resultSent) this.action("cancel");
    this.current = undefined;
  }

  private emit(event: LogsSearchEvent, properties: Record<string, unknown>) {
    if (!this.current) return;
    this.capture(event, {
      ...this.current.metadata,
      search_id: this.current.id,
      timing_origin: this.current.timingOrigin,
      ...properties,
    });
  }
}
