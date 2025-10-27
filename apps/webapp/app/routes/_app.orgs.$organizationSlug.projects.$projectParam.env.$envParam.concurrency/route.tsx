import { PlusIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import {
  type ConcurrencyResult,
  type EnvironmentWithConcurrency,
  ManageConcurrencyPresenter,
} from "~/presenters/v3/ManageConcurrencyPresenter.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, regionsPath, v3BillingPath } from "~/utils/pathBuilder";
import { SetDefaultRegionService } from "~/v3/services/setDefaultRegion.server";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Concurrency | Trigger.dev`,
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

  const presenter = new ManageConcurrencyPresenter();
  const [error, result] = await tryCatch(
    presenter.call({
      userId: userId,
      projectId: project.id,
      organizationId: project.organizationId,
    })
  );

  if (error) {
    throw new Response(undefined, {
      status: 400,
      statusText: error.message,
    });
  }

  return typedjson(result);
};

const FormSchema = z.object({
  regionId: z.string(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);

  const redirectPath = regionsPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam }
  );

  if (!project) {
    throw redirectWithErrorMessage(redirectPath, request, "Project not found");
  }

  const formData = await request.formData();
  const parsedFormData = FormSchema.safeParse(Object.fromEntries(formData));

  if (!parsedFormData.success) {
    throw redirectWithErrorMessage(redirectPath, request, "No region specified");
  }

  const service = new SetDefaultRegionService();
  const [error, result] = await tryCatch(
    service.call({
      projectId: project.id,
      regionId: parsedFormData.data.regionId,
      isAdmin: user.admin || user.isImpersonating,
    })
  );

  if (error) {
    return redirectWithErrorMessage(redirectPath, request, error.message);
  }

  return redirectWithSuccessMessage(redirectPath, request, `Set ${result.name} as default`);
};

export default function Page() {
  const {
    canAddConcurrency,
    extraConcurrency,
    extraAllocatedConcurrency,
    extraUnallocatedConcurrency,
    environments,
  } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Concurrency" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {environments.map((environment) => (
                <Property.Item key={environment.id}>
                  <Property.Label>
                    {environment.type}{" "}
                    {environment.branchName ? ` (${environment.branchName})` : ""}
                  </Property.Label>
                  <Property.Value>{environment.id}</Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <MainHorizontallyCenteredContainer>
          {canAddConcurrency ? (
            <Upgradable
              canAddConcurrency={canAddConcurrency}
              extraConcurrency={extraConcurrency}
              extraAllocatedConcurrency={extraAllocatedConcurrency}
              extraUnallocatedConcurrency={extraUnallocatedConcurrency}
              environments={environments}
            />
          ) : (
            <NotUpgradable environments={environments} />
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

function Upgradable({
  canAddConcurrency,
  extraConcurrency,
  extraAllocatedConcurrency,
  extraUnallocatedConcurrency,
  environments,
}: ConcurrencyResult) {
  const organization = useOrganization();

  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-grid-dimmed pb-1">
        <Header2>Your concurrency</Header2>
      </div>
      <Paragraph variant="small">
        Concurrency limits determine how many runs you can execute at the same time. You can add
        extra concurrency to your organization which you can allocate to environments in your
        projects.
      </Paragraph>
      <div className="mt-3 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center first-letter:pb-1">
            <Header3 className="grow">Extra concurrency</Header3>
            <Button variant="primary/small" LeadingIcon={PlusIcon}>
              Purchase extra concurrency...
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className="pl-0">Extra concurrency purchased</TableHeaderCell>
                <TableHeaderCell alignment="right" className="text-text-bright">
                  {extraConcurrency}
                </TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Allocated concurrency</TableCell>
                <TableCell alignment="right" className="text-text-bright">
                  {extraAllocatedConcurrency}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Unallocated concurrency</TableCell>
                <TableCell
                  alignment="right"
                  className={extraUnallocatedConcurrency > 0 ? "text-success" : "text-text-bright"}
                >
                  {extraUnallocatedConcurrency}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center pb-1">
            <Header3 className="grow">Concurrency allocation</Header3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className="pl-0">Environment</TableHeaderCell>
                <TableHeaderCell alignment="right">
                  <span className="flex items-center gap-x-1">
                    Included{" "}
                    <InfoIconTooltip content="This is the included concurrency based on your plan." />
                  </span>
                </TableHeaderCell>
                <TableHeaderCell alignment="right">Extra concurrency</TableHeaderCell>
                <TableHeaderCell alignment="right">Total</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {environments.map((environment) => (
                <TableRow key={environment.id}>
                  <TableCell className="pl-0">
                    <EnvironmentCombo environment={environment} />
                  </TableCell>
                  <TableCell alignment="right">{environment.planConcurrencyLimit}</TableCell>
                  <TableCell alignment="right" className="text-text-bright">
                    {Math.max(
                      0,
                      environment.maximumConcurrencyLimit - environment.planConcurrencyLimit
                    )}
                  </TableCell>
                  <TableCell alignment="right">{environment.maximumConcurrencyLimit}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function NotUpgradable({ environments }: { environments: EnvironmentWithConcurrency[] }) {
  const { isManagedCloud } = useFeatures();
  const plan = useCurrentPlan();
  const organization = useOrganization();

  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-grid-dimmed pb-1">
        <Header2>Your concurrency</Header2>
      </div>
      {isManagedCloud ? (
        <>
          <Paragraph variant="small">
            Concurrency limits determine how many runs you can execute at the same time. You can
            upgrade your plan to get more concurrency. You are currently on the{" "}
            {plan?.v3Subscription?.plan?.title ?? "Free"} plan.
          </Paragraph>
          <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
            Upgrade for more concurrency
          </LinkButton>
        </>
      ) : null}
      <div className="mt-3 flex flex-col gap-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell className="pl-0">Environment</TableHeaderCell>
              <TableHeaderCell alignment="right">Concurrency limit</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {environments.map((environment) => (
              <TableRow key={environment.id}>
                <TableCell className="pl-0">
                  <EnvironmentCombo environment={environment} />
                </TableCell>
                <TableCell alignment="right">{environment.maximumConcurrencyLimit}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
