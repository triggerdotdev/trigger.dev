import {
  ArrowUpCircleIcon,
  BookOpenIcon,
  ChatBubbleLeftEllipsisIcon,
} from "@heroicons/react/20/solid";
import { LockOpenIcon } from "@heroicons/react/24/solid";
import { Await, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense } from "react";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
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
import {
  ConcurrencyPresenter,
  type Environment,
} from "~/presenters/v3/ConcurrencyPresenter.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, ProjectParamSchema, v3BillingPath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Concurrency limits | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new ConcurrencyPresenter();
    const result = await presenter.call({
      userId,
      projectSlug: projectParam,
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
  const { environments } = useTypedLoaderData<typeof loader>();

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
            Concurrency docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="flex flex-col">
          <Table containerClassName="border-t-0">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Environment</TableHeaderCell>
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
                <Await resolve={environments} errorElement={<p>Error loading environments</p>}>
                  {(environments) => <EnvironmentsTable environments={environments} />}
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

function EnvironmentsTable({ environments }: { environments: Environment[] }) {
  return (
    <>
      {environments.map((environment) => (
        <TableRow key={environment.id}>
          <TableCell>
            <EnvironmentCombo environment={environment} />
          </TableCell>
          <TableCell alignment="right">{environment.queued}</TableCell>
          <TableCell alignment="right">{environment.concurrency}</TableCell>
          <TableCell alignment="right">{environment.concurrencyLimit}</TableCell>
        </TableRow>
      ))}
    </>
  );
}
