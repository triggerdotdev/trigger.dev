import { XMarkIcon } from "@heroicons/react/20/solid";
import { useEffect, useState } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { SpanView } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route";
import { v3RunPath, v3RunSpanPath } from "~/utils/pathBuilder";
import {
  useRunPanelData,
  useRunSpanId,
  useSessionPanelStore,
  useSpanConfirmed,
} from "./sessionPanelStore";
import { SESSION_SPAN_TAB_PARAM, type SessionTraceSelection } from "./sessionTraceSelection";
import { fetchRunsPage } from "./useSessionRunPages";
import { useSessionViewAnalytics } from "./useSessionViewAnalytics";

type RunOrSpanSelection = Exclude<SessionTraceSelection, { kind: "session" }>;

/** The side panel for a selected run or span, with a way out to the run page. */
export function SessionRunInspector({
  selection,
  runsPath,
  onClose,
}: {
  selection: RunOrSpanSelection;
  /** The session runs route, to look up a run's span id the tree hasn't supplied. */
  runsPath: string;
  onClose: () => void;
}) {
  const track = useSessionViewAnalytics();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const run = { friendlyId: selection.runFriendlyId };
  const runSpanId = useRunSpanId(selection.runFriendlyId);
  const panelData = useRunPanelData(selection.runFriendlyId);

  // A run the tree hasn't supplied (Conversation tab, or its page didn't load): read it once.
  const store = useSessionPanelStore();
  const [lookup, setLookup] = useState<{
    runFriendlyId: string;
    attempt: number;
    outcome?: "failed" | "notInSession" | "notStarted";
  }>({ runFriendlyId: selection.runFriendlyId, attempt: 0 });
  const lookupAttempt = lookup.runFriendlyId === selection.runFriendlyId ? lookup.attempt : 0;
  const lookupOutcome =
    lookup.runFriendlyId === selection.runFriendlyId ? lookup.outcome : undefined;
  useEffect(() => {
    if (runSpanId || !store) return;
    const controller = new AbortController();
    const runFriendlyId = selection.runFriendlyId;
    void fetchRunsPage(runsPath, { run: runFriendlyId, size: 1 }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        const spanId = result.ok ? result.page.view[runFriendlyId]?.spanId : undefined;
        if (spanId) {
          store.setRunSpanIds({ [runFriendlyId]: { spanId } });
          return;
        }
        // A 200 without a span id: the run is in the session but not in the run store yet.
        setLookup({
          runFriendlyId,
          attempt: lookupAttempt,
          outcome: result.ok
            ? "notStarted"
            : result.status === 404 || result.status === 400
              ? "notInSession"
              : "failed",
        });
      }
    );
    return () => controller.abort();
  }, [runSpanId, store, runsPath, selection.runFriendlyId, lookupAttempt]);
  const retryLookup = () =>
    setLookup({ runFriendlyId: selection.runFriendlyId, attempt: lookupAttempt + 1 });

  // The span route sends a span it can't find to the run page, so only a span the tree has
  // seen opens its panel. Until then (or on a tab without the tree) the run panel stands in.
  const selectedSpanId = selection.kind === "span" ? selection.spanId : undefined;
  const spanConfirmed = useSpanConfirmed(selection.runFriendlyId, selectedSpanId);
  const spanId = selectedSpanId && spanConfirmed ? selectedSpanId : runSpanId;
  const runPagePath =
    selection.kind === "span"
      ? v3RunSpanPath(organization, project, environment, run, { spanId: selection.spanId })
      : v3RunPath(organization, project, environment, run);
  const openRunPage = (
    <LinkButton
      variant="secondary/small"
      to={runPagePath}
      onClick={() => track("open_run_page", { from: "panel" })}
    >
      Open run page
    </LinkButton>
  );

  // The run's own span isn't known yet: its runs page hasn't loaded or it isn't in the run store.
  if (!spanId) {
    return (
      <div className="grid h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
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
        {lookupOutcome ? (
          // A brand-new run can be missing while the replica catches up, so both offer a retry.
          <div className="flex flex-col items-start gap-2 p-3">
            <Paragraph variant="small/dimmed">
              {lookupOutcome === "notStarted"
                ? "This run hasn't started yet."
                : lookupOutcome === "notInSession"
                  ? "This run isn't in this session."
                  : "Couldn't load this run's details."}
            </Paragraph>
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

  return (
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
}
