import { ArrowUpCircleIcon, BookOpenIcon } from "@heroicons/react/20/solid";
import { Await } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense } from "react";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Feedback } from "~/components/Feedback";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex items-center justify-between p-2 pl-3">
              <Header2>Environments</Header2>
              {plan ? (
                plan?.v3Subscription?.plan?.limits.concurrentRuns.canExceed ? (
                  <Feedback
                    button={
                      <Button LeadingIcon={ArrowUpCircleIcon} variant="tertiary/small">
                        Request more concurrency
                      </Button>
                    }
                    defaultValue="help"
                  />
                ) : (
                  <LinkButton
                    LeadingIcon={ArrowUpCircleIcon}
                    to={v3BillingPath(organization)}
                    variant="tertiary/small"
                  >
                    Upgrade for more concurrency
                  </LinkButton>
                )
              ) : null}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Environment</TableHeaderCell>
                  <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                  <TableHeaderCell alignment="right">Running</TableHeaderCell>
                  <TableHeaderCell alignment="right">Concurrency limit</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Suspense fallback={<Spinner />}>
                  <Await resolve={environments} errorElement={<p>Error loading environments</p>}>
                    {(environments) => <EnvironmentsTable environments={environments} />}
                  </Await>
                </Suspense>
              </TableBody>
            </Table>
          </div>
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
            <EnvironmentLabel environment={environment} userName={environment.userName} />
          </TableCell>
          <TableCell alignment="right">{environment.queued}</TableCell>
          <TableCell alignment="right">{environment.concurrency}</TableCell>
          <TableCell alignment="right">{environment.concurrencyLimit}</TableCell>
        </TableRow>
      ))}
    </>
  );
}
