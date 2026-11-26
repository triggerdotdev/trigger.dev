import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher, useLocation } from "@remix-run/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { InlineCode } from "~/components/code/InlineCode";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { RelativeDateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Hint } from "~/components/primitives/Hint";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner, SpinnerWhite } from "~/components/primitives/Spinner";
import { TextLink } from "~/components/primitives/TextLink";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useProject } from "~/hooks/useProject";
import type { SkewProtectionThresholdChoices } from "~/presenters/v3/SkewProtectionThresholdPresenter.server";
import type { loader as thresholdLoader } from "~/routes/resources.$projectId.deployments.skew-protection-threshold";
import { docsPath } from "~/utils/pathBuilder";
import { compareDeploymentVersions } from "~/v3/utils/deploymentVersions";

// The skew protection threshold controls: the Upgrade sessions dialog (opened from the Skew
// protection page and from an agent or task page), the Deployments row badges, and the rollback
// warning.

export type TaskThreshold = { task: string; version: string };

/** On a Deployments row: a badge when the version is the environment's threshold, and one for tasks. */
export function ThresholdBadges({
  version,
  thresholdVersion,
  taskThresholds,
}: {
  version: string;
  thresholdVersion?: string;
  taskThresholds: TaskThreshold[];
}) {
  const tasks = taskThresholds
    .filter((threshold) => threshold.version === version)
    .map((threshold) => threshold.task);
  return (
    <>
      {thresholdVersion === version && (
        <SimpleTooltip
          button={<Badge variant="extra-small">Threshold</Badge>}
          content="Skew protection threshold: sessions on older versions move to the current deployment the next time they're used."
          disableHoverableContent
        />
      )}
      {tasks.length > 0 && (
        <SimpleTooltip
          button={
            <Badge variant="extra-small">
              {tasks.length === 1 ? `Threshold: ${tasks[0]}` : `Threshold: ${tasks.length} tasks`}
            </Badge>
          }
          content={
            tasks.length === 1
              ? `Skew protection threshold for ${tasks[0]} only: its sessions on older versions move to the current deployment the next time they're used.`
              : `Skew protection threshold for ${tasks.join(", ")}: their sessions on older versions move to the current deployment the next time they're used.`
          }
          disableHoverableContent
        />
      )}
    </>
  );
}

export const SKEW_PROTECTION_ACTION = (projectId: string) =>
  `/resources/${projectId}/deployments/skew-protection-threshold`;

/** What the dialog shows, loaded when it opens and again after a clear. */
function useThresholdChoices(params: { environmentId: string; task?: string }) {
  const project = useProject();
  const fetcher = useFetcher<typeof thresholdLoader>();
  const search = new URLSearchParams({ environmentId: params.environmentId });
  if (params.task) search.set("task", params.task);
  const url = `${SKEW_PROTECTION_ACTION(project.id)}?${search.toString()}`;
  const reload = () => fetcher.load(url);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per open
  }, [url]);

  const data = fetcher.data;
  const choices: SkewProtectionThresholdChoices | undefined =
    data && "choices" in data ? data.choices : undefined;
  return { choices, failed: data !== undefined && choices === undefined, reload };
}

type UpgradeSessionsDialogProps = {
  environmentId: string;
  /** One task's threshold; absent for the environment's, which covers every task. */
  task?: string;
  /** The version the picker starts on (a Deployments row's); otherwise the newest, usually current. */
  initialVersion?: string;
  /** Called once a set lands, after the dialog closes. */
  onSet?: () => void;
  /** The trigger. */
  children: ReactNode;
};

/**
 * The Upgrade sessions dialog: where the threshold stands (with Clear), the agent's `versionSkew`
 * for one task, and the sentence that sets it.
 */
export function UpgradeSessionsDialog({ children, onSet, ...props }: UpgradeSessionsDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        {/* Mounted only while open, so its choices load when it opens and not with the page. */}
        {open && (
          <UpgradeSessionsBody
            {...props}
            onSet={() => {
              setOpen(false);
              onSet?.();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const VERSION_SKEW_TEXT: Record<string, string> = {
  follow: "Sessions move between replies",
  hold: "Sessions move only when the agent asks",
};

/** What an agent's `versionSkew` does here. */
export function versionSkewText(versionSkew: string): string | undefined {
  return VERSION_SKEW_TEXT[versionSkew];
}

function UpgradeSessionsBody({
  environmentId,
  task,
  initialVersion,
  onSet,
}: Omit<UpgradeSessionsDialogProps, "children" | "onSet"> & { onSet: () => void }) {
  const project = useProject();
  const location = useLocation();
  const fetcher = useFetcher();
  const { choices, failed, reload } = useThresholdChoices({ environmentId, task });
  const [chosenVersion, setChosenVersion] = useState(initialVersion);

  const submitting = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : undefined;
  const lastIntent = useRef<FormDataEntryValue>();
  useEffect(() => {
    if (submitting) {
      lastIntent.current = submitting;
    } else if (lastIntent.current) {
      const intent = lastIntent.current;
      lastIntent.current = undefined;
      if (intent === "set") onSet();
      else reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a submission ends
  }, [submitting]);

  const versions = choices?.versions ?? [];
  const version = chosenVersion && versions.includes(chosenVersion) ? chosenVersion : versions[0];
  const currentVersion = choices?.currentVersion ?? undefined;
  const threshold = choices?.threshold ?? null;
  const redirectUrl = `${location.pathname}${location.search}`;
  const formAction = SKEW_PROTECTION_ACTION(project.id);
  const versionLabel = (value: string) => (value === currentVersion ? `${value} (current)` : value);

  return (
    <>
      <DialogHeader>Upgrade sessions</DialogHeader>
      <div className="flex flex-col gap-4 pt-3">
        <div className="divide-y divide-grid-dimmed rounded-md border border-grid-bright">
          <StatusRow label="Threshold">
            {!choices ? (
              failed ? (
                <span className="text-text-dimmed">Couldn't load the threshold.</span>
              ) : (
                <Spinner className="size-3.5" />
              )
            ) : threshold ? (
              <>
                <StatusValue
                  value={`Before ${threshold.version}`}
                  detail={
                    <>
                      {threshold.scope === "environment" && task
                        ? "For every task in this environment. "
                        : null}
                      {thresholdSetByLabel(threshold)},{" "}
                      <RelativeDateTime date={threshold.setAt} capitalize={false} />
                    </>
                  }
                />
                {/* An agent page clears only the agent's own; the environment's is cleared on Session upgrades. */}
                {(threshold.scope === "task" || !task) && (
                  <fetcher.Form action={formAction} method="post">
                    <input type="hidden" name="intent" value="clear" />
                    <input type="hidden" name="environmentId" value={environmentId} />
                    {task && <input type="hidden" name="task" value={task} />}
                    <Button
                      type="submit"
                      name="redirectUrl"
                      value={redirectUrl}
                      variant="secondary/small"
                      LeadingIcon={submitting === "clear" ? Spinner : undefined}
                      disabled={submitting !== undefined}
                    >
                      Clear
                    </Button>
                  </fetcher.Form>
                )}
              </>
            ) : (
              <StatusValue value="None" detail="Sessions stay on the version they started on" />
            )}
          </StatusRow>
          {task && choices && choices.versionSkew !== undefined && (
            <StatusRow label="In code">
              {choices.versionSkew === null ? (
                <StatusValue value="Not reported by this version's SDK" dimmed />
              ) : (
                <StatusValue
                  value={
                    <InlineCode variant="extra-small">
                      versionSkew: "{choices.versionSkew}"
                    </InlineCode>
                  }
                  detail={versionSkewText(choices.versionSkew)}
                />
              )}
            </StatusRow>
          )}
        </div>
        {choices && versions.length === 0 ? (
          <Paragraph variant="small">
            {task
              ? `${task} isn't in any deployed version at or below the current one, so there is nothing to set yet.`
              : "No deployed version is at or below the current one yet."}
          </Paragraph>
        ) : (
          <InputGroup>
            <Label variant="small">Minimum version</Label>
            <Select
              value={version ?? ""}
              setValue={(value) => {
                if (typeof value === "string") setChosenVersion(value);
              }}
              variant="secondary/small"
              dropdownIcon
              placeholder="Loading versions…"
              disabled={!choices}
              text={(value) => (value ? versionLabel(value) : undefined)}
            >
              {versions.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {versionLabel(choice)}
                </SelectItem>
              ))}
            </Select>
            <Hint>
              Sessions{task ? "" : " of every agent"} on versions before this move to the current
              version{currentVersion ? ` (${currentVersion})` : ""} the next time they're used.
            </Hint>
          </InputGroup>
        )}
        <Paragraph variant="small">
          <TextLink to={docsPath("deployment/skew-protection-threshold")} target="_blank">
            How it works
          </TextLink>
        </Paragraph>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
        <fetcher.Form action={formAction} method="post">
          <input type="hidden" name="intent" value="set" />
          <input type="hidden" name="environmentId" value={environmentId} />
          <input type="hidden" name="version" value={version ?? ""} />
          {task && <input type="hidden" name="task" value={task} />}
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectUrl}
            variant="primary/medium"
            LeadingIcon={submitting === "set" ? SpinnerWhite : ShieldCheckIcon}
            disabled={submitting !== undefined || !version}
            shortcut={{ modifiers: ["mod"], key: "enter" }}
          >
            {threshold ? "Raise threshold" : "Upgrade sessions"}
          </Button>
        </fetcher.Form>
      </DialogFooter>
    </>
  );
}

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-3 py-2">
      <span className="w-20 shrink-0 text-xs text-text-dimmed">{label}</span>
      {children}
    </div>
  );
}

function StatusValue({
  value,
  detail,
  dimmed = false,
}: {
  value: ReactNode;
  detail?: ReactNode;
  dimmed?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className={dimmed ? "text-sm text-text-dimmed" : "text-sm text-text-bright"}>
        {value}
      </span>
      {detail && <span className="text-xs text-text-dimmed">{detail}</span>}
    </div>
  );
}

export function thresholdSetByLabel(threshold: {
  setBy: { type: string; name: string | null } | null;
  byYou: boolean;
}): string {
  if (threshold.byYou) return "Set by you";
  const text = thresholdSetByText(threshold);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Shown in the rollback dialog when the rollback target is below a threshold, which clears it:
 * the environment's, and each task's own.
 */
export function RollbackClearsThresholdWarning({
  targetVersion,
  thresholdVersion,
  taskThresholds = [],
}: {
  targetVersion: string;
  thresholdVersion?: string;
  taskThresholds?: TaskThreshold[];
}) {
  const isCleared = (version: string) => compareDeploymentVersions(targetVersion, version) === -1;
  const cleared = [
    ...(thresholdVersion && isCleared(thresholdVersion)
      ? [{ name: "Every task", version: thresholdVersion }]
      : []),
    ...taskThresholds
      .filter((threshold) => isCleared(threshold.version))
      .map((threshold) => ({ name: threshold.task, version: threshold.version })),
  ];
  if (cleared.length === 0) return null;

  if (cleared.length === 1 && thresholdVersion && isCleared(thresholdVersion)) {
    return (
      <Callout variant="warning">
        <Paragraph variant="small" className="text-callout-warning-text">
          Rolling back to {targetVersion} clears the skew protection threshold at {thresholdVersion}
          . Sessions on versions before {thresholdVersion} stop moving to the current deployment and
          their stored pins apply again.
        </Paragraph>
      </Callout>
    );
  }

  return (
    <Callout variant="warning">
      <div className="flex flex-col gap-1.5">
        <Paragraph variant="small" className="text-callout-warning-text">
          Rolling back to {targetVersion} clears{" "}
          {cleared.length === 1
            ? "this skew protection threshold"
            : `these ${cleared.length} skew protection thresholds`}
          :
        </Paragraph>
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-sm text-callout-warning-text">
          {cleared.map((threshold) => (
            <li key={threshold.name} className="flex items-baseline justify-between gap-3">
              <span className="truncate">{threshold.name}</span>
              <span className="tabular-nums">{threshold.version}</span>
            </li>
          ))}
        </ul>
        <Paragraph variant="small" className="text-callout-warning-text">
          Their sessions on older versions stop moving to the current deployment and their stored
          pins apply again.
        </Paragraph>
      </div>
    </Callout>
  );
}

function thresholdSetByText(threshold: {
  setBy: { type: string; name: string | null } | null;
}): string {
  return threshold.setBy?.type === "user"
    ? `set by ${threshold.setBy.name ?? "a team member"}`
    : threshold.setBy?.type === "api"
      ? "set through the API"
      : threshold.setBy?.type === "migrated"
        ? "set by Trigger.dev"
        : "set";
}
