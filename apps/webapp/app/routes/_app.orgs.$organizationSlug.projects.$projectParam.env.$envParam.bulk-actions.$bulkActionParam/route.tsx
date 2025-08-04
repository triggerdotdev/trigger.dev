import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { Form, useRevalidator } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { BulkActionStatus, BulkActionType } from "@trigger.dev/database";
import { motion } from "framer-motion";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { BulkActionFilterSummary } from "~/components/BulkActionFilterSummary";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { BulkActionStatusCombo, BulkActionTypeCombo } from "~/components/runs/v3/BulkAction";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { BulkActionPresenter } from "~/presenters/v3/BulkActionPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import {
  EnvironmentParamSchema,
  v3BulkActionPath,
  v3BulkActionsPath,
  v3CreateBulkActionPath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";

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

export const action = async ({ request, params }: ActionFunctionArgs) => {
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

  const service = new BulkActionService();
  const [error, result] = await tryCatch(service.abort(bulkActionParam, environment.id));

  if (error) {
    logger.error("Failed to abort bulk action", {
      error,
    });

    return redirectWithErrorMessage(
      v3BulkActionPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam },
        { friendlyId: bulkActionParam }
      ),
      request,
      `Failed to abort bulk action: ${error.message}`
    );
  }

  return redirectWithSuccessMessage(
    v3BulkActionPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
      { friendlyId: bulkActionParam }
    ),
    request,
    "Bulk action aborted"
  );
};

export default function Page() {
  const { bulkAction } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const disabled = bulkAction.status !== BulkActionStatus.PENDING;

  const streamedEvents = useEventSource(
    `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.id}/runs/bulkaction/${bulkAction.friendlyId}/stream`,
    {
      event: "progress",
      disabled,
    }
  );

  const revalidation = useRevalidator();

  useEffect(() => {
    if (disabled || streamedEvents === null) {
      return;
    }

    revalidation.revalidate();
  }, [streamedEvents, disabled]);

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-dimmed">
        <Header2 className={cn("truncate whitespace-nowrap")}>
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
        {bulkAction.status === "PENDING" ? (
          <Form method="post">
            <Button type="submit" variant="danger/small">
              Abort bulk action
            </Button>
          </Form>
        ) : null}
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="space-y-3">
          <div className="px-3 pt-3">
            <Meter
              type={bulkAction.type}
              successCount={bulkAction.successCount}
              failureCount={bulkAction.failureCount}
              totalCount={bulkAction.totalCount}
            />
          </div>
          <div className="px-3 pb-3">
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
              <Property.Item>
                <Property.Label>Summary</Property.Label>
                <Property.Value>
                  <BulkActionFilterSummary
                    selected={bulkAction.totalCount}
                    mode={bulkAction.mode}
                    action={bulkAction.type === BulkActionType.REPLAY ? "replay" : "cancel"}
                    filters={bulkAction.filters}
                    final={true}
                  />
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
          leadingIconClassName="text-indigo-500"
        >
          View runs
        </LinkButton>
      </div>
    </div>
  );
}

type MeterProps = {
  type: BulkActionType;
  successCount: number;
  failureCount: number;
  totalCount: number;
};

function Meter({ type, successCount, failureCount, totalCount }: MeterProps) {
  const successPercentage = totalCount === 0 ? 0 : (successCount / totalCount) * 100;
  const failurePercentage = totalCount === 0 ? 0 : (failureCount / totalCount) * 100;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Paragraph variant="small/bright">Runs</Paragraph>
        <Paragraph variant="extra-small">
          {formatNumber(successCount + failureCount)}/{formatNumber(totalCount)}
        </Paragraph>
      </div>
      <div className="relative h-4 w-full overflow-hidden rounded-sm bg-charcoal-900">
        <motion.div
          className="absolute left-0 top-0 h-full w-full bg-success"
          initial={{ width: `${successPercentage}%` }}
          animate={{ width: `${successPercentage}%` }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
        <motion.div
          className="absolute top-0 h-full w-full bg-charcoal-550"
          initial={{ width: `${failurePercentage}%`, left: `${successPercentage}%` }}
          animate={{ width: `${failurePercentage}%`, left: `${successPercentage}%` }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <div className="h-2 w-2 rounded-[1px] bg-success" />
          <Paragraph variant="extra-small">
            {formatNumber(successCount)} {typeText(type)} successfully
          </Paragraph>
        </div>
        <div className="flex items-center gap-1">
          <div className="h-2 w-2 rounded-[1px] bg-charcoal-550" />
          <Paragraph variant="extra-small">
            {formatNumber(failureCount)} {typeText(type)} failed{" "}
            {type === BulkActionType.CANCEL ? " (already finished)" : ""}
          </Paragraph>
        </div>
      </div>
    </div>
  );
}

function typeText(type: BulkActionType) {
  switch (type) {
    case BulkActionType.CANCEL:
      return "canceled";
    case BulkActionType.REPLAY:
      return "replayed";
  }
}
