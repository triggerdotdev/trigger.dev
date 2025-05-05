import { BookOpenIcon } from "@heroicons/react/20/solid";
import { Outlet, useParams, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { NoWaitpointTokens } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { ListPagination } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { RunTag } from "~/components/runs/v3/RunTag";
import { WaitpointStatusCombo } from "~/components/runs/v3/WaitpointStatus";
import {
  WaitpointSearchParamsSchema,
  WaitpointTokenFilters,
} from "~/components/runs/v3/WaitpointTokenFilters";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { WaitpointListPresenter } from "~/presenters/v3/WaitpointListPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  docsPath,
  EnvironmentParamSchema,
  v3WaitpointHttpCallbackPath,
  v3WaitpointTokenPath,
} from "~/utils/pathBuilder";

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
    id: url.searchParams.get("id") ?? undefined,
    statuses: url.searchParams.getAll("statuses"),
    idempotencyKey: url.searchParams.get("idempotencyKey") ?? undefined,
    tags: url.searchParams.getAll("tags"),
    period: url.searchParams.get("period") ?? undefined,
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
    const presenter = new WaitpointListPresenter();
    const result = await presenter.call({
      environment,
      resolver: "HTTP_CALLBACK",
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
  const { success, tokens, pagination, hasFilters, hasAnyTokens, filters } =
    useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const { waitpointParam } = useParams();
  const isShowingWaitpoint = !!waitpointParam;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="HTTP callbacks" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton variant={"docs/small"} LeadingIcon={BookOpenIcon} to={docsPath("/wait")}>
            Waitpoints docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {!hasAnyTokens ? (
          <MainCenteredContainer className="max-w-md">
            <NoWaitpointTokens />
          </MainCenteredContainer>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="max-h-full">
            <ResizablePanel id="waitpoint-tokens-main" min={"100px"}>
              <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
                <div className="flex items-start justify-between gap-x-2 p-2">
                  <WaitpointTokenFilters hasFilters={hasFilters} />
                  <div className="flex items-center justify-end gap-x-2">
                    <ListPagination list={{ pagination }} />
                  </div>
                </div>
                <div className="grid h-fit max-h-full min-h-full grid-rows-[1fr] overflow-x-auto">
                  <Table containerClassName="border-t">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell className="w-[1%]">Created</TableHeaderCell>
                        <TableHeaderCell className="w-[20%]">ID</TableHeaderCell>
                        <TableHeaderCell className="w-[20%]">URL</TableHeaderCell>
                        <TableHeaderCell className="w-[20%]">Status</TableHeaderCell>
                        <TableHeaderCell className="w-[20%]">Completed</TableHeaderCell>
                        <TableHeaderCell className="w-[20%]">Idempotency Key</TableHeaderCell>
                        <TableHeaderCell className="w-[20%]">Tags</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tokens.length > 0 ? (
                        tokens.map((token) => {
                          const ttlExpired =
                            token.idempotencyKeyExpiresAt &&
                            token.idempotencyKeyExpiresAt < new Date();

                          const path = v3WaitpointHttpCallbackPath(
                            organization,
                            project,
                            environment,
                            token,
                            filters
                          );
                          const rowIsSelected = waitpointParam === token.id;

                          return (
                            <TableRow
                              key={token.id}
                              className={rowIsSelected ? "bg-grid-dimmed" : undefined}
                            >
                              <TableCell to={path}>
                                <span className="opacity-60">
                                  <DateTime date={token.createdAt} />
                                </span>
                              </TableCell>
                              <TableCell to={path}>
                                <CopyableText value={token.id} className="font-mono" />
                              </TableCell>
                              <TableCell to={path}>
                                <ClipboardField
                                  value={token.callbackUrl}
                                  variant={"secondary/small"}
                                />
                              </TableCell>
                              <TableCell to={path}>
                                <WaitpointStatusCombo status={token.status} className="text-xs" />
                              </TableCell>
                              <TableCell to={path}>
                                {token.completedAt ? <DateTime date={token.completedAt} /> : "–"}
                              </TableCell>
                              <TableCell to={path}>
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
                              <TableCell to={path} actionClassName="py-1">
                                <div className="flex gap-1">
                                  {token.tags.map((tag) => <RunTag key={tag} tag={tag} />) || "–"}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      ) : (
                        <TableRow>
                          <TableCell colSpan={6}>
                            <div className="grid place-items-center py-6 text-text-dimmed">
                              <Paragraph>No waitpoint tokens found</Paragraph>
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
            </ResizablePanel>
            {isShowingWaitpoint && (
              <>
                <ResizableHandle id="waitpoint-tokens-handle" />
                <ResizablePanel id="waitpoint-tokens-inspector" min="100px" default="500px">
                  <Outlet />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}
      </PageBody>
    </PageContainer>
  );
}
