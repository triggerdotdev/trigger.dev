import { tryCatch } from "@trigger.dev/core/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRunsPage } from "~/presenters/v3/SessionRunsPresenter.server";

export const RUNS_PAGE_SIZE = 20;

type SessionRun = SessionRunsPage["data"][number];

export type LoadedRuns = {
  /** Every run loaded so far by friendlyId; a later read replaces an earlier one. */
  runsById: ReadonlyMap<string, SessionRun>;
  view: SessionRunsPage["view"];
  totalCount: number;
  /** Cursor for the page before the oldest loaded run. */
  earlierCursor: string | undefined;
};

type PagesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; loaded: LoadedRuns; loadingEarlier: boolean; earlierError?: string };

async function fetchRunsPage(
  runsPath: string,
  after: string | undefined,
  signal: AbortSignal
): Promise<{ ok: true; page: SessionRunsPage } | { ok: false; message: string }> {
  const url = new URL(runsPath, window.location.origin);
  url.searchParams.set("page[size]", String(RUNS_PAGE_SIZE));
  if (after) url.searchParams.set("page[after]", after);

  const [error, response] = await tryCatch(fetch(url, { signal }));
  if (error) return { ok: false, message: "Couldn't load this session's runs." };
  if (!response.ok) {
    return { ok: false, message: `Couldn't load this session's runs (${response.status}).` };
  }

  const [parseError, page] = await tryCatch(response.json() as Promise<SessionRunsPage>);
  if (parseError) return { ok: false, message: "Couldn't read this session's runs." };
  return { ok: true, page };
}

/** Adds a page to the runs loaded so far. A newer read of a run replaces the older one. */
export function mergeSessionRunPage(
  loaded: LoadedRuns | undefined,
  page: SessionRunsPage,
  kind: "newest" | "earlier"
): LoadedRuns {
  if (loaded && kind === "newest" && pageChangesNothing(loaded, page)) return loaded;

  const runsById = new Map(loaded?.runsById);
  for (const run of page.data) runsById.set(run.friendlyId, run);
  return {
    runsById,
    view: { ...loaded?.view, ...page.view },
    totalCount: kind === "newest" ? page.totalCount : (loaded?.totalCount ?? page.totalCount),
    earlierCursor: kind === "earlier" || !loaded ? page.pagination.next : loaded.earlierCursor,
  };
}

// A quiet poll returns the same runs; keeping the same object avoids rebuilding the tree.
function pageChangesNothing(loaded: LoadedRuns, page: SessionRunsPage) {
  if (page.totalCount !== loaded.totalCount) return false;
  return page.data.every((run) => {
    const known = loaded.runsById.get(run.friendlyId);
    return (
      known !== undefined &&
      JSON.stringify(known) === JSON.stringify(run) &&
      JSON.stringify(loaded.view[run.friendlyId]) === JSON.stringify(page.view[run.friendlyId])
    );
  });
}

/** The session's newest page of runs, plus earlier pages loaded on request. */
export function useSessionRunPages(runsPath: string) {
  const [state, setState] = useState<PagesState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const earlierController = useRef<AbortController | null>(null);
  const refreshController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRunsPage(runsPath, undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(
        result.ok
          ? {
              status: "ready",
              loaded: mergeSessionRunPage(undefined, result.page, "newest"),
              loadingEarlier: false,
            }
          : { status: "error", message: result.message }
      );
    });
    return () => {
      controller.abort();
      earlierController.current?.abort();
      refreshController.current?.abort();
    };
  }, [runsPath, attempt]);

  const loaded = state.status === "ready" ? state.loaded : undefined;
  const earlierCursor = loaded?.earlierCursor;
  const loadingEarlier = state.status === "ready" && state.loadingEarlier;

  const loadEarlier = useCallback(() => {
    if (!earlierCursor || loadingEarlier) return;

    const controller = new AbortController();
    earlierController.current = controller;
    setState((prev) =>
      prev.status === "ready" ? { ...prev, loadingEarlier: true, earlierError: undefined } : prev
    );
    void fetchRunsPage(runsPath, earlierCursor, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        return result.ok
          ? {
              status: "ready",
              loaded: mergeSessionRunPage(prev.loaded, result.page, "earlier"),
              loadingEarlier: false,
            }
          : { ...prev, loadingEarlier: false, earlierError: result.message };
      });
    });
  }, [runsPath, earlierCursor, loadingEarlier]);

  // Re-reads the newest page, e.g. when a run starts or finishes. Runs already loaded stay.
  const refreshNewest = useCallback(() => {
    if (refreshController.current) return;
    const controller = new AbortController();
    refreshController.current = controller;
    void fetchRunsPage(runsPath, undefined, controller.signal).then((result) => {
      if (refreshController.current === controller) refreshController.current = null;
      if (controller.signal.aborted || !result.ok) return;
      setState((prev) =>
        prev.status === "ready"
          ? { ...prev, loaded: mergeSessionRunPage(prev.loaded, result.page, "newest") }
          : prev
      );
    });
  }, [runsPath]);

  const runs = useMemo(() => (loaded ? [...loaded.runsById.values()] : undefined), [loaded]);

  return {
    state,
    runs,
    totalCount: loaded?.totalCount ?? 0,
    view: loaded?.view ?? {},
    canLoadEarlier: earlierCursor !== undefined,
    loadingEarlier,
    earlierError: state.status === "ready" ? state.earlierError : undefined,
    loadEarlier,
    refreshNewest,
    retry: () => {
      setState({ status: "loading" });
      setAttempt((n) => n + 1);
    },
  };
}
