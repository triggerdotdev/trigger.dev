import { tryCatch } from "@trigger.dev/core/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRunsPage } from "~/presenters/v3/SessionRunsPresenter.server";

export const RUNS_PAGE_SIZE = 20;

type PagesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; pages: SessionRunsPage[]; loadingEarlier: boolean; earlierError?: string };

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
  if (!response.ok)
    return { ok: false, message: `Couldn't load this session's runs (${response.status}).` };

  const [parseError, page] = await tryCatch(response.json() as Promise<SessionRunsPage>);
  if (parseError) return { ok: false, message: "Couldn't read this session's runs." };
  return { ok: true, page };
}

/** The session's newest page of runs, plus earlier pages loaded on request. */
export function useSessionRunPages(runsPath: string) {
  const [state, setState] = useState<PagesState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const earlierController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRunsPage(runsPath, undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(
        result.ok
          ? { status: "ready", pages: [result.page], loadingEarlier: false }
          : { status: "error", message: result.message }
      );
    });
    return () => {
      controller.abort();
      earlierController.current?.abort();
    };
  }, [runsPath, attempt]);

  const pages = state.status === "ready" ? state.pages : undefined;
  const nextCursor = pages?.at(-1)?.pagination.next;
  const loadingEarlier = state.status === "ready" && state.loadingEarlier;

  const loadEarlier = useCallback(() => {
    if (!nextCursor || loadingEarlier) return;

    const controller = new AbortController();
    earlierController.current = controller;
    setState((prev) =>
      prev.status === "ready" ? { ...prev, loadingEarlier: true, earlierError: undefined } : prev
    );
    void fetchRunsPage(runsPath, nextCursor, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        return result.ok
          ? { status: "ready", pages: [...prev.pages, result.page], loadingEarlier: false }
          : { ...prev, loadingEarlier: false, earlierError: result.message };
      });
    });
  }, [runsPath, nextCursor, loadingEarlier]);

  const merged = useMemo(() => {
    if (!pages) return undefined;
    return {
      runs: pages.flatMap((page) => page.data),
      totalCount: pages[0]?.totalCount ?? 0,
      view: Object.assign({}, ...pages.map((page) => page.view)) as SessionRunsPage["view"],
    };
  }, [pages]);

  return {
    state,
    runs: merged?.runs,
    totalCount: merged?.totalCount ?? 0,
    view: merged?.view ?? {},
    canLoadEarlier: nextCursor !== undefined,
    loadingEarlier,
    earlierError: state.status === "ready" ? state.earlierError : undefined,
    loadEarlier,
    retry: () => {
      setState({ status: "loading" });
      setAttempt((n) => n + 1);
    },
  };
}
