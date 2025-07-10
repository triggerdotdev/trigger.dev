import { ArrowPathIcon, BookOpenIcon } from "@heroicons/react/20/solid";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
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
import { BulkActionStatusCombo, BulkActionTypeCombo } from "~/components/runs/v3/BulkAction";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { ScheduleTypeCombo } from "~/components/runs/v3/ScheduleType";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { BulkActionPresenter } from "~/presenters/v3/BulkActionPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  v3BulkActionsPath,
  v3CreateBulkActionPath,
  v3RunsPath,
} from "~/utils/pathBuilder";

const BulkActionParamSchema = EnvironmentParamSchema.extend({
  bulkActionParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const { organizationSlug, projectParam, envParam, bulkActionParam } =
    BulkActionParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  try {
    const presenter = new BulkActionPresenter();
    const [error, data] = await tryCatch(
      presenter.call({
        environmentId: environment.id,
        bulkActionId: bulkActionParam,
      })
    );

    if (error) {
      throw new Error(error.message);
    }

    return typedjson({ bulkAction: data });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { bulkAction } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>
          {bulkAction.name || bulkAction.friendlyId}
        </Header2>
        <LinkButton
          to={v3BulkActionsPath(organization, project, environment)}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed px-3 text-sm">
        <BulkActionStatusCombo status={bulkAction.status} />
        {bulkAction.status !== "PENDING" ? (
          <Button variant="danger/small">About bulk action...</Button>
        ) : null}
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="space-y-3">
          <div className="p-3">
            <Property.Table>
              <Property.Item>
                <Property.Label>ID</Property.Label>
                <Property.Value>
                  <CopyableText value={bulkAction.friendlyId} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Bulk action</Property.Label>
                <Property.Value>
                  <BulkActionTypeCombo type={bulkAction.type} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>User</Property.Label>
                <Property.Value>
                  {bulkAction.user ? (
                    <div className="flex items-center gap-1">
                      <UserAvatar
                        name={bulkAction.user.name}
                        avatarUrl={bulkAction.user.avatarUrl}
                        className="h-4 w-4"
                      />
                      <Paragraph variant="extra-small">{bulkAction.user.name}</Paragraph>
                    </div>
                  ) : (
                    "–"
                  )}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Created</Property.Label>
                <Property.Value>
                  <DateTime date={bulkAction.createdAt} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Completed</Property.Label>
                <Property.Value>
                  {bulkAction.completedAt ? <DateTime date={bulkAction.completedAt} /> : "–"}
                </Property.Value>
              </Property.Item>
            </Property.Table>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
        <LinkButton
          to={v3CreateBulkActionPath(
            organization,
            project,
            environment,
            {
              bulkId: bulkAction.friendlyId,
            },
            undefined,
            "replay"
          )}
          variant="tertiary/medium"
          LeadingIcon={ArrowPathIcon}
          leadingIconClassName="text-indigo-500"
        >
          Replay runs
        </LinkButton>

        <LinkButton
          variant="tertiary/medium"
          to={v3RunsPath(organization, project, environment, {
            bulkId: bulkAction.friendlyId,
          })}
          LeadingIcon={RunsIcon}
        >
          View runs
        </LinkButton>
      </div>
    </div>
  );
}
