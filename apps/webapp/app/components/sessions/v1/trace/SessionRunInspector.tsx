import { XMarkIcon } from "@heroicons/react/20/solid";
import { useCallback, useEffect, useState } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { SpanView } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route";
import { cn } from "~/utils/cn";
import { v3RunPath, v3RunSpanPath } from "~/utils/pathBuilder";
import {
  useRunNote,
  useRunPanelData,
  useRunSettled,
  useRunSpanId,
  useSessionPanelStore,
  useSpanConfirmed,
} from "./sessionPanelStore";
import {
  notShownText,
  panelLinksToRunPage,
  runFactsOf,
  runNotShown,
  spanNotLoaded,
  startedBecauseText,
  startingEndsAtMs,
  type RunFacts,
  type RunNotShown,
} from "./sessionRunNote";
import { SESSION_SPAN_TAB_PARAM, type SessionTraceSelection } from "./sessionTraceSelection";
import { fetchRunsPage } from "./useSessionRunPages";
import { useSessionViewAnalytics } from "./useSessionViewAnalytics";

type RunOrSpanSelection = Exclude<SessionTraceSelection, { kind: "session" }>;

/** The side panel for a selected run or span, with a way out to the run page. */
export function SessionRunInspector({
  selection,
  runsPath,
  onTraceTab,
  onClose,
}: {
  selection: RunOrSpanSelection;
  /** The session runs route, to look up a run's span id the tree hasn't supplied. */
  runsPath: string;
  /** The Trace tab is shown: only it can say a linked span never loaded. */
  onTraceTab: boolean;
  onClose: () => void;
}) {
  const track = useSessionViewAnalytics();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const run = { friendlyId: selection.runFriendlyId };
  const runSpanId = useRunSpanId(selection.runFriendlyId);
  const panelData = useRunPanelData(selection.runFriendlyId);
  const { facts, loadNote } = useRunNote(selection.runFriendlyId);
  const inRunStore = runSpanId !== undefined;

  // A run the tree hasn't supplied (Conversation tab, or its page didn't load): read its facts
  // once, or again on Try again. Nothing is kept here but how the read went.
  const store = useSessionPanelStore();
  const [lookup, setLookup] = useState<{
    runFriendlyId: string;
    attempt: number;
    outcome?: "failed" | "notInSession";
  }>({ runFriendlyId: selection.runFriendlyId, attempt: 0 });
  const lookupCurrent = lookup.runFriendlyId === selection.runFriendlyId;
  const lookupAttempt = lookupCurrent ? lookup.attempt : 0;
  const lookupOutcome = lookupCurrent ? lookup.outcome : undefined;
  // Facts from a paused Trace tab can be stale, so a run not in the run store is always read once
  // (one request: the run only leaves this state by getting a span id).
  const wantsLookup = facts === undefined || !inRunStore || lookupAttempt > 0;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!wantsLookup || !store) return;
    const controller = new AbortController();
    const runFriendlyId = selection.runFriendlyId;
    void fetchRunsPage(runsPath, { run: runFriendlyId, size: 1 }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        const row = result.ok
          ? result.page.data.find((item) => item.friendlyId === runFriendlyId)
          : undefined;
        if (result.ok && row) {
          const entry = result.page.view[runFriendlyId];
          store.setRuns({
            [runFriendlyId]: { facts: runFactsOf(row, entry), spanId: entry?.spanId },
          });
          setLookup({ runFriendlyId, attempt: lookupAttempt });
          // Only a read that answered moves the clock: a failed one can't say the run never started.
          setNowMs(Date.now());
          return;
        }
        setLookup({
          runFriendlyId,
          attempt: lookupAttempt,
          outcome:
            result.ok || result.status === 404 || result.status === 400 ? "notInSession" : "failed",
        });
      }
    );
    return () => controller.abort();
  }, [wantsLookup, store, runsPath, selection.runFriendlyId, lookupAttempt]);
  const retryLookup = useCallback(
    () =>
      setLookup((prev) => ({
        runFriendlyId: selection.runFriendlyId,
        attempt: (prev.runFriendlyId === selection.runFriendlyId ? prev.attempt : 0) + 1,
      })),
    [selection.runFriendlyId]
  );

  // A run not in the run store is "starting" until 5 minutes after it was triggered. At that point
  // (or at once if it already passed) the panel reads the run's facts again, since nothing else
  // refreshes them while the Trace tab is paused, and moves its clock forward when the read
  // settles: a run that started gets its span id, one that didn't turns into "never started".
  const startingEndsAt = facts && !inRunStore ? startingEndsAtMs(facts) : undefined;
  useEffect(() => {
    if (startingEndsAt === undefined) return;
    const remaining = Math.max(0, startingEndsAt - Date.now());
    const timer = setTimeout(retryLookup, remaining + 50);
    return () => clearTimeout(timer);
  }, [startingEndsAt, retryLookup]);
  const notShown = runNotShown({ facts, inRunStore, loadNote, nowMs });

  // The span route sends a span it can't find to the run page, so only a span the tree has
  // seen opens its panel. Until then (or on a tab without the tree) the run panel stands in.
  const selectedSpanId = selection.kind === "span" ? selection.spanId : undefined;
  const spanConfirmed = useSpanConfirmed(selection.runFriendlyId, selectedSpanId);
  const spanId = selectedSpanId && spanConfirmed ? selectedSpanId : runSpanId;
  const runSettled = useRunSettled(selection.runFriendlyId);
  const showSpanNotLoaded = spanNotLoaded({
    spanId: selectedSpanId,
    runSpanId,
    spanSeen: spanConfirmed,
    runSettled,
    onTraceTab,
  });
  const runPagePath =
    selection.kind === "span"
      ? v3RunSpanPath(organization, project, environment, run, { spanId: selection.spanId })
      : v3RunPath(organization, project, environment, run);
  const openRunPage = panelLinksToRunPage(notShown) ? (
    <LinkButton
      variant="secondary/small"
      to={runPagePath}
      onClick={() => track("open_run_page", { from: "panel", reason: notShown?.kind })}
    >
      Open run page
    </LinkButton>
  ) : null;
  const hasNote = facts !== undefined || notShown !== undefined || showSpanNotLoaded;
  const runNote = <RunNote info={facts} notShown={notShown} spanNotLoaded={showSpanNotLoaded} />;

  // The run's own span isn't known yet: its runs page hasn't loaded or it isn't in the run store.
  if (!spanId) {
    return (
      <div
        className={cn(
          "grid h-full overflow-hidden bg-background-bright",
          hasNote ? "grid-rows-[2.5rem_auto_1fr]" : "grid-rows-[2.5rem_1fr]"
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed px-3">
          <span className="truncate font-mono text-sm text-text-dimmed">
            {selection.runFriendlyId}
          </span>
          <div className="flex items-center gap-1">
            {openRunPage}
            <Button
              variant="minimal/small"
              TrailingIcon={XMarkIcon}
              onClick={onClose}
              shortcut={{ key: "esc" }}
              shortcutPosition="before-trailing-icon"
            />
          </div>
        </div>
        {runNote}
        {lookupOutcome || facts ? (
          // A run can be missing while the replica catches up, or queued for a long time, so
          // every outcome offers a retry. The note above says whether it's starting.
          <div className="flex flex-col items-start gap-2 p-3">
            {lookupOutcome && (
              <Paragraph variant="small/dimmed">
                {lookupOutcome === "notInSession"
                  ? "This run isn't in this session."
                  : "Couldn't load this run's details."}
              </Paragraph>
            )}
            <Button variant="secondary/small" onClick={retryLookup}>
              Try again
            </Button>
          </div>
        ) : (
          <Paragraph variant="small/dimmed" className="p-3">
            This run's details aren't available here yet.
          </Paragraph>
        )}
      </div>
    );
  }

  const spanView = (
    <SpanView
      runParam={selection.runFriendlyId}
      spanId={spanId}
      spanOverrides={panelData?.overridesBySpanId?.[spanId]}
      linkedRunId={panelData?.linkedRunIdBySpanId?.[spanId]}
      refreshKey={panelData?.refreshKey}
      tabParam={SESSION_SPAN_TAB_PARAM}
      hideFocusOnRun
      closePanel={onClose}
      headerAccessory={openRunPage}
    />
  );
  // The note belongs to the run panel; a span panel shows the span alone. Without a note the
  // panel takes the whole height, so it still scrolls.
  if (spanId !== runSpanId || !hasNote) return spanView;
  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
      {runNote}
      <div className="min-h-0 overflow-hidden">{spanView}</div>
    </div>
  );
}

/** Session-only context above the run panel: the run's place in the session and, if its spans
 * can't be shown in the Trace tab, why. */
function RunNote({
  info,
  notShown,
  spanNotLoaded,
}: {
  info: RunFacts | undefined;
  notShown: RunNotShown | undefined;
  /** A linked span never loaded here; the header's "Open run page" goes to it. */
  spanNotLoaded: boolean;
}) {
  if (!info && !notShown && !spanNotLoaded) return null;
  return (
    <div className="flex flex-col gap-0.5 border-b border-grid-dimmed bg-background-bright px-3 py-2">
      {info && <Paragraph variant="small">{startedBecauseText(info)}</Paragraph>}
      {notShown && <Paragraph variant="small/dimmed">{notShownText(notShown)}</Paragraph>}
      {spanNotLoaded && (
        <Paragraph variant="small/dimmed">
          This span isn't loaded here. Open run page to see it.
        </Paragraph>
      )}
    </div>
  );
}
