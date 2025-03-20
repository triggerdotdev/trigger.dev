import {
  ArrowUpCircleIcon,
  BookOpenIcon,
  ChatBubbleLeftEllipsisIcon,
  PauseIcon,
  PlayIcon,
} from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import upgradeForQueuesPath from "~/assets/images/queues-dashboard.png";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { Feedback } from "~/components/Feedback";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { ListPagination } from "~/components/ListPagination";
import { BigNumber } from "~/components/metrics/BigNumber";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { WaitpointStatusCombo } from "~/components/runs/v3/WaitpointStatus";
import { WaitpointSearchParamsSchema } from "~/components/runs/v3/WaitpointTokenFilters";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { WaitpointTokenListPresenter } from "~/presenters/v3/WaitpointTokenListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3BillingPath } from "~/utils/pathBuilder";
import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";
import { PauseQueueService } from "~/v3/services/pauseQueue.server";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Waitpoint tokens | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);
  const s = {
    friendlyId: url.searchParams.get("friendlyId") ?? undefined,
    statuses: url.searchParams.getAll("statuses"),
    idempotencyKey: url.searchParams.get("idempotencyKey") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
  };

  const searchParams = WaitpointSearchParamsSchema.parse(s);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  try {
    const presenter = new WaitpointTokenListPresenter();
    const result = await presenter.call({
      environment,
      ...searchParams,
    });

    return typedjson(result);
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { tokens, pagination, filters, hasFilters } = useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const project = useProject();
  const env = useEnvironment();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Waitpoint Tokens" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/waitpoints")}
          >
            Waitpoints docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
          <div className="grid h-fit max-h-full min-h-full grid-rows-[1fr] overflow-x-auto">
            <Table containerClassName="border-t">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className="w-[1%]">Created</TableHeaderCell>
                  <TableHeaderCell>ID</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Completed</TableHeaderCell>
                  <TableHeaderCell>Idempotency Key</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.length > 0 ? (
                  tokens.map((token) => {
                    const ttlExpired =
                      token.idempotencyKeyExpiresAt && token.idempotencyKeyExpiresAt < new Date();

                    return (
                      <TableRow key={token.friendlyId}>
                        <TableCell>
                          <span className="opacity-60">
                            <DateTime date={token.createdAt} />
                          </span>
                        </TableCell>
                        <TableCell>{token.friendlyId}</TableCell>
                        <TableCell>
                          <WaitpointStatusCombo
                            status={token.status}
                            outputIsError={token.isTimeout}
                            className="text-xs"
                          />
                        </TableCell>
                        <TableCell>
                          {token.completedAt ? <DateTime date={token.completedAt} /> : "–"}
                        </TableCell>
                        {/* <TableCell>
                        {token.completedAfter ? (
                          token.isTimeout ? (
                            <SimpleTooltip
                              content="This waitpoint timed out"
                              button={<DateTime date={token.completedAfter} />}
                            />
                          ) : (
                            <span className="opacity-50">
                              <DateTime date={token.completedAfter} />
                            </span>
                          )
                        ) : (
                          "–"
                        )}
                      </TableCell> */}
                        <TableCell>
                          {" "}
                          {token.idempotencyKey ? (
                            token.idempotencyKeyExpiresAt ? (
                              <SimpleTooltip
                                content={
                                  <>
                                    <DateTime date={token.idempotencyKeyExpiresAt} />
                                    {ttlExpired ? (
                                      <span className="text-xs opacity-50"> (expired)</span>
                                    ) : null}
                                  </>
                                }
                                buttonClassName={ttlExpired ? "opacity-50" : undefined}
                                button={token.idempotencyKey}
                              />
                            ) : (
                              token.idempotencyKey
                            )
                          ) : (
                            "–"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <div className="grid place-items-center py-6 text-text-dimmed">
                        No waitpoint tokens found
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            {(pagination.next || pagination.previous) && (
              <div className="flex justify-end border-t border-grid-dimmed px-2 py-3">
                <ListPagination list={{ pagination }} />
              </div>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
