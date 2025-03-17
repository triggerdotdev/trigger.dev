import {
  ArrowUpCircleIcon,
  BookOpenIcon,
  ChatBubbleLeftEllipsisIcon,
  RectangleStackIcon,
} from "@heroicons/react/20/solid";
import { LockOpenIcon } from "@heroicons/react/24/solid";
import { Await, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense } from "react";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { Feedback } from "~/components/Feedback";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { findProjectBySlug } from "~/models/project.server";
import { QueueListPresenter, type Environment } from "~/presenters/v3/QueueListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3BillingPath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { Badge } from "~/components/primitives/Badge";
import { Header2 } from "~/components/primitives/Headers";
import { TaskIcon } from "~/assets/icons/TaskIcon";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Queues | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  try {
    const presenter = new QueueListPresenter();
    const result = await presenter.call({
      userId,
      projectId: project.id,
      organizationId: project.organizationId,
      environmentSlug: envParam,
    });

    return typeddefer(result);
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { environment, queues } = useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const plan = useCurrentPlan();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Concurrency limits" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/queue-concurrency")}
          >
            Queues docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="flex flex-col">
          <Table containerClassName="border-t-0">
            <TableHeader>
              <TableRow>
                <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                <TableHeaderCell alignment="right">Running</TableHeaderCell>
                <TableHeaderCell alignment="right">Concurrency limit</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              <Suspense
                fallback={
                  <TableRow>
                    <TableCell colSpan={4}>
                      <div className="grid place-items-center py-6">
                        <Spinner />
                      </div>
                    </TableCell>
                  </TableRow>
                }
              >
                <Await resolve={environment} errorElement={<p>Error loading environments</p>}>
                  {(environment) => <EnvironmentTable environment={environment} />}
                </Await>
              </Suspense>
            </TableBody>
          </Table>

          <Header2>Queues</Header2>
          <Table containerClassName="mt-8 border-t">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                <TableHeaderCell alignment="right">Running</TableHeaderCell>
                <TableHeaderCell alignment="right">Concurrency limit</TableHeaderCell>
                <TableHeaderCell alignment="right">
                  <span className="sr-only">Pause/resume</span>
                </TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              <Suspense
                fallback={
                  <TableRow>
                    <TableCell colSpan={5}>
                      <div className="grid place-items-center py-6">
                        <Spinner />
                      </div>
                    </TableCell>
                  </TableRow>
                }
              >
                <Await
                  resolve={Promise.all([queues, environment])}
                  errorElement={<p>Error loading queues</p>}
                >
                  {([queues, environment]) =>
                    queues.length > 0 ? (
                      queues.map((queue) => (
                        <TableRow key={queue.name}>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              {queue.type === "VIRTUAL" ? (
                                <TaskIcon className="size-4 text-blue-500" />
                              ) : (
                                <RectangleStackIcon className="size-4 text-purple-500" />
                              )}
                              <span>{queue.name}</span>
                            </span>
                          </TableCell>
                          <TableCell alignment="right">{queue.queued}</TableCell>
                          <TableCell alignment="right">{queue.running}</TableCell>
                          <TableCell alignment="right">
                            {queue.concurrencyLimit ?? (
                              <span className="text-text-dimmed">
                                Max ({environment.concurrencyLimit})
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <div className="grid place-items-center py-6 text-text-dimmed">
                            No queues found
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  }
                </Await>
              </Suspense>
            </TableBody>
          </Table>

          {plan ? (
            plan?.v3Subscription?.plan?.limits.concurrentRuns.canExceed ? (
              <div className="flex w-full items-center justify-end gap-2 pl-3 pr-2 pt-3">
                <Paragraph variant="small" className="text-text-bright">
                  Need more concurrency?
                </Paragraph>
                <Feedback
                  button={
                    <Button LeadingIcon={ChatBubbleLeftEllipsisIcon} variant="tertiary/small">
                      Request more
                    </Button>
                  }
                  defaultValue="help"
                />
              </div>
            ) : (
              <div className="flex w-full items-center justify-end gap-2 pl-3 pr-2 pt-3">
                <LockOpenIcon className="size-5 min-w-5 text-indigo-500" />
                <Paragraph variant="small" className="text-text-bright">
                  Upgrade for more concurrency
                </Paragraph>
                <LinkButton
                  to={v3BillingPath(organization, "Upgrade your plan for more concurrency")}
                  variant="secondary/small"
                  LeadingIcon={ArrowUpCircleIcon}
                >
                  Upgrade
                </LinkButton>
              </div>
            )
          ) : null}
        </div>
      </PageBody>
    </PageContainer>
  );
}

function EnvironmentTable({ environment }: { environment: Environment }) {
  return (
    <TableRow>
      <TableCell alignment="right">{environment.queued}</TableCell>
      <TableCell alignment="right">{environment.concurrency}</TableCell>
      <TableCell alignment="right">{environment.concurrencyLimit}</TableCell>
    </TableRow>
  );
}
