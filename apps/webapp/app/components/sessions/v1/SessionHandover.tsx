import { ArrowLeftIcon, ArrowRightIcon, ShieldCheckIcon } from "@heroicons/react/20/solid";
import { LinkButton } from "~/components/primitives/Buttons";
import * as Property from "~/components/primitives/PropertyTable";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TextLink } from "~/components/primitives/TextLink";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { v3RunPath } from "~/utils/pathBuilder";
import { type HandoverRun, handoverWhy, type SessionHandover } from "./sessionHandoverData";

// The dashboard's view of a reply that moved to another run partway through: in the session
// page's conversation and Runs tab, and on both runs' pages as related runs.

function useRunPath(run: HandoverRun): string {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return v3RunPath(organization, project, environment, { friendlyId: run.friendlyId });
}

function HandoverRunLink({ run, className }: { run: HandoverRun; className?: string }) {
  return (
    <TextLink to={useRunPath(run)} className={cn("font-mono", className)}>
      {run.friendlyId}
    </TextLink>
  );
}

function Version({ version }: { version: string | null }) {
  return <span className="tabular-nums text-text-bright">{version ?? "unknown version"}</span>;
}

function VersionMove({ handover }: { handover: SessionHandover }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Version version={handover.from?.version ?? null} />
      <ArrowRightIcon className="size-3 text-text-dimmed" aria-label="to" />
      <Version version={handover.to.version} />
    </span>
  );
}

function SkewMark({ className }: { className?: string }) {
  return (
    <ShieldCheckIcon className={cn("size-3.5 shrink-0 text-blue-500", className)} aria-hidden />
  );
}

// ---------- Session page ----------

/** Where the reply moved, drawn in the conversation in place of the step divider. */
export function HandoverDivider({ handover }: { handover: SessionHandover }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex-1 border-t border-blue-500/40" />
      <SimpleTooltip
        button={
          <span className="flex items-center gap-1.5 rounded-sm border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs text-text-dimmed">
            <SkewMark />
            <span>
              Moved after step {handover.afterSteps}: <VersionMove handover={handover} />
            </span>
          </span>
        }
        content={
          <span className="flex flex-col gap-0.5 text-xs">
            <span>
              {handover.from?.friendlyId ?? "The previous run"} handed the reply to{" "}
              {handover.to.friendlyId}.
            </span>
            <span>Why: {handoverWhy(handover)}</span>
          </span>
        }
        disableHoverableContent
      />
      <div className="flex-1 border-t border-blue-500/40" />
    </div>
  );
}

/** The Runs tab line under a run that continued a reply. */
export function HandoverRunsTabDetail({ handover }: { handover: SessionHandover }) {
  return (
    <span className="flex flex-col gap-0.5 text-xs text-text-dimmed">
      <span>
        After step {handover.afterSteps}: <VersionMove handover={handover} />
      </span>
      <span className="flex items-center gap-1">
        <SkewMark />
        {handoverWhy(handover)}
      </span>
    </span>
  );
}

// ---------- Run pages ----------

type RunHandovers = { handedOverTo?: SessionHandover; continuedFrom?: SessionHandover };

/** Buttons in the trace tree's header, beside Root and Parent. */
export function RunContinuationButtons({ handedOverTo, continuedFrom }: RunHandovers) {
  const fromPath = useOptionalRunPath(continuedFrom?.from ?? undefined);
  const toPath = useOptionalRunPath(handedOverTo?.to);
  return (
    <div className="flex items-center">
      {continuedFrom?.from && fromPath ? (
        <LinkButton
          variant="minimal/small"
          to={fromPath}
          LeadingIcon={ArrowLeftIcon}
          leadingIconClassName="gap-x-2"
          tooltip={`Continued the reply of ${continuedFrom.from.friendlyId} (${continuedFrom.from.version ?? "unknown version"}) from step ${continuedFrom.afterSteps + 1}`}
          className="text-xs"
        >
          Continued from
        </LinkButton>
      ) : null}
      {handedOverTo && toPath ? (
        <LinkButton
          variant="minimal/small"
          to={toPath}
          TrailingIcon={ArrowRightIcon}
          tooltip={`Handed the reply to ${handedOverTo.to.friendlyId} (${handedOverTo.to.version ?? "unknown version"}) after step ${handedOverTo.afterSteps}`}
          className="text-xs"
        >
          Continued in
        </LinkButton>
      ) : null}
    </div>
  );
}

function useOptionalRunPath(run: HandoverRun | undefined): string | undefined {
  const path = useRunPath(run ?? { friendlyId: "", version: null });
  return run ? path : undefined;
}

/** Detail tab rows beside Root and Parent run. */
export function RunContinuationProperties({ handedOverTo, continuedFrom }: RunHandovers) {
  return (
    <>
      {continuedFrom?.from ? (
        <Property.Item>
          <Property.Label>Continued from</Property.Label>
          <Property.Value>
            <ContinuationValue
              run={continuedFrom.from}
              detail={`${stepsRan(continuedFrom.afterSteps).toLowerCase()} ran there`}
              handover={continuedFrom}
            />
          </Property.Value>
        </Property.Item>
      ) : null}
      {handedOverTo ? (
        <Property.Item>
          <Property.Label>Continued in</Property.Label>
          <Property.Value>
            <ContinuationValue
              run={handedOverTo.to}
              detail={`from step ${handedOverTo.afterSteps + 1}`}
              handover={handedOverTo}
            />
          </Property.Value>
        </Property.Item>
      ) : null}
    </>
  );
}

function ContinuationValue({
  run,
  detail,
  handover,
}: {
  run: HandoverRun;
  detail: string;
  handover: SessionHandover;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <HandoverRunLink run={run} className="break-all" />
      <span className="flex flex-wrap items-center gap-x-1 text-xs text-text-dimmed">
        <span>
          <Version version={run.version} />, {detail}
        </span>
        <SimpleTooltip
          button={<SkewMark />}
          content={`Moved by the ${handoverWhy(handover)}`}
          disableHoverableContent
        />
      </span>
    </span>
  );
}

function stepsRan(afterSteps: number): string {
  return afterSteps === 1 ? "Step 1" : `Steps 1 to ${afterSteps}`;
}
