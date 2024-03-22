import { BookOpenIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { WhatAreHttpEndpoints } from "~/components/helpContent/HelpContentText";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Icon } from "~/components/primitives/Icon";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { HttpEndpointsPresenter } from "~/presenters/HttpEndpointsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, docsPath, projectHttpEndpointPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  const presenter = new HttpEndpointsPresenter();
  const httpEndpoints = await presenter.call({ userId, slug: projectParam });

  return typedjson({ httpEndpoints });
};

export default function Page() {
  const { httpEndpoints } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="HTTP endpoints" />
        <PageAccessories>
          <LinkButton
            variant={"minimal/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("documentation/concepts/http-endpoints")}
          >
            HTTP endpoints documentation
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <Help defaultOpen={true}>
          {(open) => (
            <div className={cn("grid h-full gap-4", open ? "grid-cols-2" : "grid-cols-1")}>
              <div>
                <div className="mb-2 flex items-center justify-end gap-x-2">
                  <HelpTrigger title="What are HTTP endpoints?" />
                </div>
                <div className="mb-8">
                  <Table fullWidth>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>ID</TableHeaderCell>
                        <TableHeaderCell>Title</TableHeaderCell>
                        <TableHeaderCell>Updated</TableHeaderCell>
                        <TableHeaderCell alignment="right">Environments</TableHeaderCell>
                        <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {httpEndpoints.length > 0 ? (
                        httpEndpoints.map((httpEndpoint) => {
                          const path = projectHttpEndpointPath(organization, project, httpEndpoint);
                          return (
                            <TableRow key={httpEndpoint.id}>
                              <TableCell to={path}>
                                <div className="flex items-center gap-1">
                                  <Icon icon={httpEndpoint.icon ?? "webhook"} className="h-4 w-4" />
                                  {httpEndpoint.key}
                                </div>
                              </TableCell>
                              <TableCell to={path}>{httpEndpoint.title ?? "–"}</TableCell>
                              <TableCell to={path}>
                                <DateTime date={httpEndpoint.updatedAt} />
                              </TableCell>
                              <TableCell alignment="right" to={path}>
                                <div className="flex items-center justify-end gap-1">
                                  {httpEndpoint.httpEndpointEnvironments.map((environment) => (
                                    <EnvironmentLabel
                                      key={environment.id}
                                      environment={environment.environment}
                                    />
                                  ))}
                                </div>
                              </TableCell>
                              <TableCellChevron to={path} isSticky />
                            </TableRow>
                          );
                        })
                      ) : (
                        <TableBlankRow colSpan={100}>
                          <Paragraph>No HTTP endpoints</Paragraph>
                        </TableBlankRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
              <HelpContent title="How to use HTTP endpoints">
                <WhatAreHttpEndpoints />
              </HelpContent>
            </div>
          )}
        </Help>
      </PageBody>
    </PageContainer>
  );
}
