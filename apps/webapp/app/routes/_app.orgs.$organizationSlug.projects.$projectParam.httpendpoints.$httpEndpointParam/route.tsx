import { KeyIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { HowToUseApiKeysAndEndpoints } from "~/components/helpContent/HelpContentText";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { Header1, Header2, Header3 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Icon } from "~/components/primitives/Icon";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
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
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { HttpEndpointPresenter } from "~/presenters/HttpEndpointPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import {
  HttpEndpointParamSchema,
  docsPath,
  projectHttpEndpointPath,
  projectHttpEndpointsPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, httpEndpointParam } = HttpEndpointParamSchema.parse(params);

  const presenter = new HttpEndpointPresenter();
  try {
    const result = await presenter.call({
      userId,
      projectSlug: projectParam,
      httpEndpointKey: httpEndpointParam,
    });

    if (!result) {
      throw new Response("Not Found", { status: 404 });
    }

    return typedjson(result);
  } catch (e) {
    console.log(e);
    throw new Response(e instanceof Error ? e.message : JSON.stringify(e), { status: 404 });
  }
};

export const handle: Handle = {
  breadcrumb: (match) => {
    const data = useTypedMatchData<typeof loader>(match);
    return (
      <BreadcrumbLink
        to={match.pathname}
        title={data?.httpEndpoint.title ?? data?.httpEndpoint.key ?? "Endpoint"}
      />
    );
  },
};

export default function Page() {
  const { httpEndpoint, environments, secret } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle
            title={httpEndpoint.title ?? httpEndpoint.key}
            backButton={{
              to: projectHttpEndpointsPath(organization, project),
              text: "HTTP endpoints",
            }}
            icon={httpEndpoint.icon ?? undefined}
          />
          <PageButtons>
            <LinkButton
              LeadingIcon={"docs"}
              to={docsPath("documentation/concepts/triggers/http-endpoints")}
              variant="secondary/small"
            >
              HTTP Endpoints documentation
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <div>
          <Header1 spacing>Setting up your webhook</Header1>
          <Paragraph spacing>
            Copy a webhook URL and secret from below, then enter them into the API service you want
            to receive webhooks from.
          </Paragraph>
          <Header3 spacing>Webhook URLs</Header3>
          <div className="mb-4 grid grid-cols-3 gap-2">
            {environments.map((environment) => (
              <div key={environment.id}>
                <ClipboardField
                  className="w-full max-w-none"
                  value={environment.webhookUrl}
                  variant={"secondary/medium"}
                  icon={<EnvironmentLabel environment={environment} />}
                />
              </div>
            ))}
          </div>
          <Header3 spacing>Secret</Header3>
          <Paragraph spacing>
            Add this secret to your environment variables, then use it in our{" "}
            <InlineCode>verify</InlineCode> function.
          </Paragraph>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <ClipboardField
              className="w-full max-w-none"
              value={secret}
              secure
              variant={"secondary/medium"}
              icon={"key"}
            />
          </div>
          <Paragraph spacing>
            <TextLink to={docsPath("documentation/concepts/triggers/http-endpoints")}>
              Read the documentation
            </TextLink>{" "}
            for full details on how to implement
          </Paragraph>
        </div>

        {/* <Table fullWidth>
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
        </Table> */}
      </PageBody>
    </PageContainer>
  );
}
