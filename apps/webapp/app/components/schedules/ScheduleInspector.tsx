import {
  BoltIcon,
  BoltSlashIcon,
  BookOpenIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { DialogDescription } from "@radix-ui/react-dialog";
import { type FetcherWithComponents, Form, useLocation } from "@remix-run/react";
import { type ReactNode } from "react";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { ScheduleTypeCombo } from "~/components/runs/v3/ScheduleType";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { v3EditSchedulePath } from "~/utils/pathBuilder";

type RunRow = React.ComponentProps<typeof TaskRunsTable>["runs"][number];

type EnvironmentRow = React.ComponentProps<typeof EnvironmentCombo>["environment"] & {
  id: string;
};

export type ScheduleInspectorData = {
  id: string;
  friendlyId: string;
  type: "DECLARATIVE" | "IMPERATIVE";
  taskIdentifier: string;
  cron: string;
  cronDescription: string;
  timezone: string;
  externalId: string | null;
  deduplicationKey: string | null;
  userProvidedDeduplicationKey: boolean;
  active: boolean;
  environments: EnvironmentRow[];
  runs: RunRow[];
  nextRuns: Date[];
};

type Props = {
  schedule: ScheduleInspectorData;
  /**
   * Right-aligned slot in the header (e.g. a back link or close button).
   */
  headerActions?: ReactNode;
  /**
   * URL the action `Form`s post to. Defaults to the current page (Form's
   * default behavior) — pass the schedule detail route when the inspector
   * is rendered somewhere else (e.g. in a sheet on a different page).
   */
  actionPath?: string;
  /** When set, Edit calls back instead of navigating to the standalone edit page. */
  onEdit?: () => void;
  /** Submits enable/disable via this fetcher with `_format=json` so the host stays put. */
  activeToggleFetcher?: FetcherWithComponents<unknown>;
  /** Submits delete via this fetcher with `_format=json` so the host stays put. */
  deleteFetcher?: FetcherWithComponents<unknown>;
};

export function ScheduleInspector({
  schedule,
  headerActions,
  actionPath,
  onEdit,
  activeToggleFetcher,
  deleteFetcher,
}: Props) {
  const location = useLocation();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const isUtc = schedule.timezone === "UTC";
  const isImperative = schedule.type === "IMPERATIVE";

  return (
    <div
      className={cn(
        "grid h-full max-h-full overflow-hidden bg-background-bright",
        isImperative ? "grid-rows-[2.5rem_1fr_auto]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className="whitespace-nowrap">{schedule.friendlyId}</Header2>
        {headerActions}
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="space-y-3">
          <div className="p-3">
            <Property.Table>
              <Property.Item>
                <Property.Label>Schedule ID</Property.Label>
                <Property.Value>{schedule.friendlyId}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Task ID</Property.Label>
                <Property.Value>{schedule.taskIdentifier}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Type</Property.Label>
                <Property.Value>
                  <ScheduleTypeCombo type={schedule.type} className="text-sm" />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>CRON</Property.Label>
                <Property.Value>
                  <div className="space-y-2">
                    <InlineCode variant="extra-small">{schedule.cron}</InlineCode>
                    <Paragraph variant="small">{schedule.cronDescription}</Paragraph>
                  </div>
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Timezone</Property.Label>
                <Property.Value>{schedule.timezone}</Property.Value>
              </Property.Item>
              <Property.Item className="gap-1">
                <Property.Label>Environment</Property.Label>
                <Property.Value>
                  <div className="flex flex-col gap-2">
                    {schedule.environments.map((env) => (
                      <EnvironmentCombo key={env.id} environment={env} className="text-xs" />
                    ))}
                  </div>
                </Property.Value>
              </Property.Item>
              {isImperative && (
                <>
                  <Property.Item>
                    <Property.Label>External ID</Property.Label>
                    <Property.Value>
                      {schedule.externalId ? schedule.externalId : "–"}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>Deduplication key</Property.Label>
                    <Property.Value>
                      {schedule.userProvidedDeduplicationKey ? schedule.deduplicationKey : "–"}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item className="gap-1.5">
                    <Property.Label>Status</Property.Label>
                    <Property.Value>
                      <EnabledStatus enabled={schedule.active} />
                    </Property.Value>
                  </Property.Item>
                </>
              )}
            </Property.Table>
          </div>
          <div className="flex flex-col gap-1">
            <Header3 className="pb-1 pl-3">Last 5 runs</Header3>
            <TaskRunsTable
              total={schedule.runs.length}
              hasFilters={false}
              filters={{
                tasks: [],
                versions: [],
                statuses: [],
                from: undefined,
                to: undefined,
              }}
              runs={schedule.runs}
              isLoading={false}
              variant="bright"
              disableAdjacentRows
            />
          </div>
          <div className="flex flex-col gap-1 pt-2">
            <Header3 className="pb-1 pl-3">Next 5 runs</Header3>
            <Table variant="bright">
              <TableHeader>
                <TableRow>
                  {!isUtc && <TableHeaderCell>{schedule.timezone}</TableHeaderCell>}
                  <TableHeaderCell>UTC</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedule.active ? (
                  schedule.nextRuns.length ? (
                    schedule.nextRuns.map((run, index) => (
                      <TableRow key={index}>
                        {!isUtc && (
                          <TableCell>
                            <DateTime date={run} timeZone={schedule.timezone} />
                          </TableCell>
                        )}
                        <TableCell>
                          <DateTime date={run} timeZone="UTC" />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableBlankRow colSpan={isUtc ? 1 : 2}>
                      <PlaceholderText title="You found a bug" />
                    </TableBlankRow>
                  )
                ) : (
                  <TableBlankRow colSpan={isUtc ? 1 : 2}>
                    <PlaceholderText title="Schedule disabled" />
                  </TableBlankRow>
                )}
              </TableBody>
            </Table>
          </div>
          {!isImperative && (
            <div className="p-3">
              <InfoPanel
                title="Editing declarative schedules"
                icon={BookOpenIcon}
                iconClassName="text-indigo-500"
                variant="info"
                accessory={
                  <LinkButton
                    to="https://trigger.dev/docs/v3/tasks-scheduled"
                    variant="docs/small"
                    LeadingIcon={BookOpenIcon}
                  >
                    Schedules docs
                  </LinkButton>
                }
                panelClassName="max-w-full"
              >
                You can only edit a declarative schedule by updating your schedules.task and then
                running the CLI dev and deploy commands.
              </InfoPanel>
            </div>
          )}
        </div>
      </div>
      {isImperative && (
        <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2 py-2">
          <div className="flex items-center gap-2">
            {(() => {
              const ToggleForm = activeToggleFetcher?.Form ?? Form;
              const isSubmitting = activeToggleFetcher?.state === "submitting";
              return (
                <ToggleForm method="post" action={actionPath}>
                  {activeToggleFetcher ? <input type="hidden" name="_format" value="json" /> : null}
                  <Button
                    type="submit"
                    variant="secondary/small"
                    LeadingIcon={schedule.active ? BoltSlashIcon : BoltIcon}
                    leadingIconClassName={schedule.active ? "text-dimmed" : "text-success"}
                    name="action"
                    value={schedule.active ? "disable" : "enable"}
                    disabled={isSubmitting}
                  >
                    {schedule.active ? "Disable" : "Enable"}
                  </Button>
                </ToggleForm>
              );
            })()}
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  type="submit"
                  variant="danger/small"
                  LeadingIcon={TrashIcon}
                  name="action"
                  value="delete"
                >
                  Delete…
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-sm">
                <DialogHeader>Delete schedule</DialogHeader>
                <DialogDescription className="mt-3">
                  Are you sure you want to delete this schedule? This can't be reversed.
                </DialogDescription>
                <DialogFooter className="sm:justify-end">
                  {(() => {
                    const DeleteForm = deleteFetcher?.Form ?? Form;
                    const isSubmitting = deleteFetcher?.state === "submitting";
                    return (
                      <DeleteForm method="post" action={actionPath}>
                        {deleteFetcher ? <input type="hidden" name="_format" value="json" /> : null}
                        <Button
                          type="submit"
                          variant="danger/medium"
                          LeadingIcon={TrashIcon}
                          name="action"
                          value="delete"
                          disabled={isSubmitting}
                        >
                          Delete
                        </Button>
                      </DeleteForm>
                    );
                  })()}
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
          <div className="flex items-center gap-4">
            {onEdit ? (
              <Button variant="secondary/small" LeadingIcon={PencilSquareIcon} onClick={onEdit}>
                Edit schedule…
              </Button>
            ) : (
              <LinkButton
                variant="secondary/small"
                to={`${v3EditSchedulePath(organization, project, environment, schedule)}${
                  location.search
                }`}
                LeadingIcon={PencilSquareIcon}
              >
                Edit schedule…
              </LinkButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PlaceholderText({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <Paragraph className="w-auto">{title}</Paragraph>
    </div>
  );
}
