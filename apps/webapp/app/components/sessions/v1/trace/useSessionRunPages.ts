import { tryCatch } from "@trigger.dev/core/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRunsPage } from "~/presenters/v3/SessionRunsPresenter.server";

export const RUNS_PAGE_SIZE = 20;
/** The most runs one click on a "not loaded" row reads (the route's page size limit). */
export const RUNS_FILL_MAX = 100;

type SessionRun = SessionRunsPage["data"][number];

export type LoadedRuns = {
  /** Every run loaded so far by friendlyId; a later read replaces an earlier one. */
  runsById: ReadonlyMap<string, SessionRun>;
  view: SessionRunsPage["view"];
  totalCount: number;
  /** Each page's `next`, keyed by that page's oldest run: reads the runs just below it. */
  cursorBelow: ReadonlyMap<string, string>;
};

/** A read of older runs: Load earlier, or filling the hole above a run. */
type OlderLoad = { kind: "earlier" } | { kind: "fill"; newerRunFriendlyId: string };

type PagesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      loaded: LoadedRuns;
      olderLoad?: OlderLoad;
      olderError?: { load: OlderLoad; message: string };
    };

/** What became of the deep-linked run, if the page opened with one. */
export type DeepLinkResult = "none" | "loaded" | "notFound" | "failed";

/** Why the newest page is read; the route labels its metrics with it. */
export type NewestPageReason = "open" | "focus" | "poll";

export type PageResult =
  | { ok: true; page: SessionRunsPage }
  | { ok: false; status: number | undefined; message: string };

export async function fetchRunsPage(
  runsPath: string,
  params: { after?: string; size?: number; run?: string; reason?: NewestPageReason },
  signal: AbortSignal
): Promise<PageResult> {
  const url = new URL(runsPath, window.location.origin);
  url.searchParams.set("page[size]", String(params.size ?? RUNS_PAGE_SIZE));
  if (params.after) url.searchParams.set("page[after]", params.after);
  if (params.run) url.searchParams.set("run", params.run);
  if (params.reason) url.searchParams.set("reason", params.reason);

  const [error, response] = await tryCatch(fetch(url, { signal }));
  if (error) return { ok: false, status: undefined, message: "Couldn't load this session's runs." };
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: `Couldn't load this session's runs (${response.status}).`,
    };
  }

  const [parseError, page] = await tryCatch(response.json() as Promise<SessionRunsPage>);
  if (parseError) {
    return { ok: false, status: undefined, message: "Couldn't read this session's runs." };
  }
  return { ok: true, page };
}

/**
 * Adds a page to the runs loaded so far. A newer read of a run replaces the older one. Only the
 * newest page moves `totalCount`; every page records its `next` under its oldest run.
 */
export function mergeSessionRunPage(
  loaded: LoadedRuns | undefined,
  page: SessionRunsPage,
  kind: "newest" | "older"
): LoadedRuns {
  if (loaded && kind === "newest" && pageChangesNothing(loaded, page)) return loaded;

  const runsById = new Map(loaded?.runsById);
  for (const run of page.data) runsById.set(run.friendlyId, run);

  const cursorBelow = new Map(loaded?.cursorBelow);
  const oldest = page.data.at(-1);
  if (oldest && page.pagination.next) cursorBelow.set(oldest.friendlyId, page.pagination.next);

  return {
    runsById,
    view: { ...loaded?.view, ...page.view },
    totalCount: kind === "newest" || !loaded ? page.totalCount : loaded.totalCount,
    cursorBelow,
  };
}

// A quiet poll returns the same runs; keeping the same object avoids rebuilding the tree.
function pageChangesNothing(loaded: LoadedRuns, page: SessionRunsPage) {
  if (page.totalCount !== loaded.totalCount) return false;
  const oldest = page.data.at(-1);
  if (oldest && page.pagination.next && !loaded.cursorBelow.has(oldest.friendlyId)) return false;
  return page.data.every((run) => {
    const known = loaded.runsById.get(run.friendlyId);
    return (
      known !== undefined &&
      JSON.stringify(known) === JSON.stringify(run) &&
      JSON.stringify(loaded.view[run.friendlyId]) === JSON.stringify(page.view[run.friendlyId])
    );
  });
}

/** Cursor for the page before the oldest loaded run; undefined once run 1 is loaded. */
export function earlierRunsCursor(loaded: LoadedRuns): string | undefined {
  let oldest: SessionRun | undefined;
  for (const run of loaded.runsById.values()) {
    if (!oldest || run.number < oldest.number) oldest = run;
  }
  return oldest ? loaded.cursorBelow.get(oldest.friendlyId) : undefined;
}

/** Cursor for the runs missing just below `newerRunFriendlyId` (the run under a "not loaded" row). */
export function holeCursor(loaded: LoadedRuns, newerRunFriendlyId: string): string | undefined {
  return loaded.cursorBelow.get(newerRunFriendlyId);
}

function sameOlderLoad(a: OlderLoad | undefined, b: OlderLoad) {
  if (!a || a.kind !== b.kind) return false;
  return (
    a.kind === "earlier" || (b.kind === "fill" && a.newerRunFriendlyId === b.newerRunFriendlyId)
  );
}

/**
 * The session's newest page of runs, plus older pages loaded on request. With a deep-linked run,
 * the page ending at that run is read together with the newest page.
 */
export function useSessionRunPages(runsPath: string, deepLinkRunFriendlyId?: string) {
  const [state, setState] = useState<PagesState>({ status: "loading" });
  const [deepLink, setDeepLink] = useState<DeepLinkResult>("none");
  const [attempt, setAttempt] = useState(0);
  const olderController = useRef<AbortController | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  // The link the tab opened with; a later selection doesn't refetch. Retry (only reachable
  // before anything loaded) reads it again.
  const [initialDeepLink] = useState(deepLinkRunFriendlyId);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetchRunsPage(runsPath, { reason: "open" }, controller.signal),
      initialDeepLink
        ? fetchRunsPage(runsPath, { run: initialDeepLink }, controller.signal)
        : undefined,
    ]).then(([newest, deep]) => {
      if (controller.signal.aborted) return;
      if (!newest.ok) {
        setState({ status: "error", message: newest.message });
        return;
      }
      let loaded = mergeSessionRunPage(undefined, newest.page, "newest");
      if (deep?.ok) loaded = mergeSessionRunPage(loaded, deep.page, "older");
      setState({ status: "ready", loaded });
      if (deep) {
        setDeepLink(
          deep.ok ? "loaded" : deep.status === 404 || deep.status === 400 ? "notFound" : "failed"
        );
      }
    });
    return () => {
      controller.abort();
      olderController.current?.abort();
      refreshController.current?.abort();
    };
  }, [runsPath, attempt, initialDeepLink]);

  const loaded = state.status === "ready" ? state.loaded : undefined;
  const olderLoad = state.status === "ready" ? state.olderLoad : undefined;
  const olderError = state.status === "ready" ? state.olderError : undefined;
  const earlierCursor = loaded ? earlierRunsCursor(loaded) : undefined;

  const loadOlder = useCallback(
    (load: OlderLoad, cursor: string | undefined, size: number) => {
      if (!cursor || olderLoad) return;

      const controller = new AbortController();
      olderController.current = controller;
      setState((prev) =>
        prev.status === "ready" ? { ...prev, olderLoad: load, olderError: undefined } : prev
      );
      void fetchRunsPage(runsPath, { after: cursor, size }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setState((prev) => {
          if (prev.status !== "ready") return prev;
          return result.ok
            ? {
                status: "ready",
                loaded: mergeSessionRunPage(prev.loaded, result.page, "older"),
              }
            : { ...prev, olderLoad: undefined, olderError: { load, message: result.message } };
        });
      });
    },
    [runsPath, olderLoad]
  );

  const loadEarlier = useCallback(
    () => loadOlder({ kind: "earlier" }, earlierCursor, RUNS_PAGE_SIZE),
    [loadOlder, earlierCursor]
  );

  /** Reads the runs missing above `newerRunFriendlyId`, newest first, up to `RUNS_FILL_MAX`. */
  const fillHole = useCallback(
    (newerRunFriendlyId: string, missing: number) => {
      if (!loaded) return;
      loadOlder(
        { kind: "fill", newerRunFriendlyId },
        holeCursor(loaded, newerRunFriendlyId),
        Math.min(Math.max(missing, 1), RUNS_FILL_MAX)
      );
    },
    [loaded, loadOlder]
  );

  // Re-reads the newest page, e.g. when a run starts or finishes. Runs already loaded stay.
  const refreshNewest = useCallback(
    (reason: NewestPageReason = "poll") => {
      if (refreshController.current) return;
      const controller = new AbortController();
      refreshController.current = controller;
      void fetchRunsPage(runsPath, { reason }, controller.signal).then((result) => {
        if (refreshController.current === controller) refreshController.current = null;
        if (controller.signal.aborted || !result.ok) return;
        setState((prev) =>
          prev.status === "ready"
            ? { ...prev, loaded: mergeSessionRunPage(prev.loaded, result.page, "newest") }
            : prev
        );
      });
    },
    [runsPath]
  );

  const runs = useMemo(() => (loaded ? [...loaded.runsById.values()] : undefined), [loaded]);

  const earlier: OlderLoad = { kind: "earlier" };

  return {
    state,
    runs,
    totalCount: loaded?.totalCount ?? 0,
    view: loaded?.view ?? {},
    deepLink,
    /** There are earlier runs and no other read of older runs is running. */
    canLoadEarlier: earlierCursor !== undefined && !olderLoad,
    loadingEarlier: sameOlderLoad(olderLoad, earlier),
    earlierError:
      olderError && sameOlderLoad(olderError.load, earlier) ? olderError.message : undefined,
    loadEarlier,
    /** Which hole is filling, by the run below it. */
    fillingRunFriendlyId: olderLoad?.kind === "fill" ? olderLoad.newerRunFriendlyId : undefined,
    /** The run below the hole whose last fill failed. */
    fillFailedRunFriendlyId:
      olderError?.load.kind === "fill" ? olderError.load.newerRunFriendlyId : undefined,
    olderLoadBusy: olderLoad !== undefined,
    fillHole,
    refreshNewest,
    retry: () => {
      setState({ status: "loading" });
      setAttempt((n) => n + 1);
    },
  };
}
