import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { HowToUseApiKeysAndEndpoints } from "~/components/helpContent/HelpContentText";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Icon } from "~/components/primitives/Icon";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import {
  Table,
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
import { Handle } from "~/utils/handle";
import { ProjectParamSchema, docsPath, projectHttpEndpointPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  const presenter = new HttpEndpointsPresenter();
  const httpEndpoints = await presenter.call({ userId, slug: projectParam });

  return typedjson({ httpEndpoints });
};

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="HTTP endpoints" />,
};

export default function Page() {
  const { httpEndpoints } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="HTTP endpoints" />
          <PageButtons>
            <LinkButton
              LeadingIcon={"docs"}
              to={docsPath("documentation/concepts/triggers/http-endpoints")}
              variant="secondary/small"
            >
              HTTP Endpoints Documentation
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageDescription>
          HTTP endpoints allow you to receive webhooks from any API.
        </PageDescription>
      </PageHeader>
      <PageBody>
        <Help defaultOpen={true}>
          {(open) => (
            <div className={cn("grid h-full gap-4", open ? "grid-cols-2" : "grid-cols-1")}>
              <div>
                <div className="mb-2 flex items-center justify-end gap-x-2">
                  <HelpTrigger title="How do I use HTTP Endpoints?" />
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
                      {httpEndpoints.map((httpEndpoint) => {
                        const path = projectHttpEndpointPath(organization, project, httpEndpoint);
                        return (
                          <TableRow key={httpEndpoint.id}>
                            <TableCell to={path}>
                              <div className="flex items-center gap-1">
                                <Icon icon={httpEndpoint.icon ?? "webhook"} className="h-4 w-4" />
                                {httpEndpoint.key}
                              </div>
                            </TableCell>
                            <TableCell to={path}>{httpEndpoint.title ?? "No title"}</TableCell>
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
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
              <HelpContent title="How to use HTTP Endpoints">
                <HowToUseApiKeysAndEndpoints />
              </HelpContent>
            </div>
          )}
        </Help>
      </PageBody>
    </PageContainer>
  );
}
