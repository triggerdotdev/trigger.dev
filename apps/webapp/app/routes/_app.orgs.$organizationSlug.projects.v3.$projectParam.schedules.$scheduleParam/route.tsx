import { PencilSquareIcon, TrashIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import cronstrue from "cronstrue";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Property, PropertyTable } from "~/components/primitives/PropertyTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { EditSchedulePresenter } from "~/presenters/v3/EditSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3ScheduleParams, v3SchedulesPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, scheduleParam } = v3ScheduleParams.parse(params);

  const presenter = new EditSchedulePresenter();
  const { schedule } = await presenter.call({
    userId,
    projectSlug: projectParam,
    friendlyId: scheduleParam,
  });

  if (!schedule) {
    throw new Error("Schedule not found");
  }

  return typedjson({ schedule });
};

export default function Page() {
  const { schedule } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr_2.5rem] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>{schedule.friendlyId}</Header2>
        <LinkButton
          to={v3SchedulesPath(organization, project)}
          variant="minimal/medium"
          LeadingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
        />
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="p-3">
          <PropertyTable>
            <Property label="Schedule ID">{schedule.friendlyId}</Property>
            <Property label="Task ID">{schedule.taskIdentifier}</Property>
            <Property label="CRON (UTC)" labelClassName="self-start">
              <div className="space-y-2">
                <InlineCode variant="extra-small">{schedule.cron}</InlineCode>
                <Paragraph variant="small">{cronstrue.toString(schedule.cron)}</Paragraph>
              </div>
            </Property>
            <Property label="Environments">
              <div className="flex flex-wrap gap-1">
                {schedule.environments.map((env) => (
                  <EnvironmentLabel
                    key={env.id}
                    size="small"
                    environment={env}
                    userName={env.userName}
                  />
                ))}
              </div>
            </Property>
            <Property label="External ID">
              {schedule.externalId ? schedule.externalId : "–"}
            </Property>
            <Property label="Deduplication key">
              {schedule.userProvidedDeduplicationKey ? schedule.deduplicationKey : "–"}
            </Property>
          </PropertyTable>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
        <div className="flex items-center gap-4">
          <Button
            type="submit"
            variant="minimal/medium"
            LeadingIcon={TrashIcon}
            leadingIconClassName="text-error"
            className="text-error"
          >
            Delete
          </Button>
        </div>
        <div className="flex items-center gap-4">
          <LinkButton variant="tertiary/medium" to="" LeadingIcon={PencilSquareIcon}>
            Edit schedule
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
