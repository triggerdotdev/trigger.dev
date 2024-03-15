import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TerminalSquareIcon } from "lucide-react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { BlankstateInstructions } from "~/components/BlankstateInstructions";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { DeploymentListPresenter } from "~/presenters/v3/DeploymentListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, docsPath, v3DeploymentPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new DeploymentListPresenter();
    const result = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
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
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();
  const { deployments, currentPage, totalPages } = useTypedLoaderData<typeof loader>();
  const hasDeployments = totalPages > 0;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
      </NavBar>
      <PageBody>
        <div className={cn("grid h-full grid-cols-1 gap-4")}>
          <div className="h-full">
            {hasDeployments ? (
              <div className="flex flex-col gap-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Deploy</TableHeaderCell>
                      <TableHeaderCell>Env</TableHeaderCell>
                      <TableHeaderCell>Version</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Tasks</TableHeaderCell>
                      <TableHeaderCell>Deployed by</TableHeaderCell>
                      <TableHeaderCell>Deployed at</TableHeaderCell>
                      <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deployments.length > 0 ? (
                      deployments.map((deployment) => {
                        const usernameForEnv =
                          user.id !== deployment.environment.userId
                            ? deployment.environment.userName
                            : undefined;
                        const path = v3DeploymentPath(organization, project, deployment);
                        return (
                          <TableRow key={deployment.id} className="group">
                            <TableCell to={path}>{deployment.shortCode}</TableCell>
                            <TableCell to={path}>{deployment.version}</TableCell>
                            <TableCell to={path}>
                              <EnvironmentLabel
                                environment={deployment.environment}
                                userName={usernameForEnv}
                              />
                            </TableCell>
                            <TableCell to={path}>{deployment.status}</TableCell>
                            <TableCell to={path}>{deployment.tasksCount ?? "–"}</TableCell>
                            <TableCell to={path}>
                              {deployment.deployedBy ? <div></div> : "–"}
                            </TableCell>
                            <TableCell to={path}>
                              {deployment.deployedAt ? (
                                <DateTime date={deployment.deployedAt} />
                              ) : (
                                "–"
                              )}
                            </TableCell>
                            <TableCellChevron to={path} />
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableBlankRow colSpan={6}>
                        <Paragraph variant="small" className="flex items-center justify-center">
                          No deploys match your filters
                        </Paragraph>
                      </TableBlankRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <CreateDeploymentInstructions />
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function CreateDeploymentInstructions() {
  return (
    <MainCenteredContainer className="max-w-prose">
      <BlankstateInstructions title="Deploy for the first time">
        <Paragraph spacing>
          There are several ways to deploy your tasks. You can use the CLI, Continuous Integration
          (like GitHub Actions), or an integration with a service like Netlify or Vercel. Make sure
          you have{" "}
          <TextLink href={docsPath("v3/deploy-environment-variables")}>
            set your environment variables
          </TextLink>{" "}
          first.
        </Paragraph>
        <div className="flex gap-3">
          <LinkButton
            to={docsPath("v3/cli-deploy")}
            variant="primary/medium"
            LeadingIcon={TerminalSquareIcon}
            className="inline-flex"
          >
            Deploy with the CLI
          </LinkButton>
          <LinkButton
            to={docsPath("v3/github-actions")}
            variant="primary/medium"
            LeadingIcon={TerminalSquareIcon}
            className="inline-flex"
          >
            Deploy with GitHub actions
          </LinkButton>
        </div>
      </BlankstateInstructions>
    </MainCenteredContainer>
  );
}
