import { BookOpenIcon, CheckIcon } from "@heroicons/react/20/solid";
import { StopIcon } from "@heroicons/react/24/outline";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { HowToConnectHttpEndpoint } from "~/components/helpContent/HelpContentText";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { Header1 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import {
  PageAccessories,
  NavBar,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { HttpEndpointPresenter } from "~/presenters/HttpEndpointPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { HttpEndpointParamSchema, docsPath, projectHttpEndpointsPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, httpEndpointParam } =
    HttpEndpointParamSchema.parse(params);

  const presenter = new HttpEndpointPresenter();
  try {
    const result = await presenter.call({
      userId,
      projectSlug: projectParam,
      organizationSlug,
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

export default function Page() {
  const { httpEndpoint, unconfiguredEnvironments, secret } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title={httpEndpoint.title ?? httpEndpoint.key}
          backButton={{
            to: projectHttpEndpointsPath(organization, project),
            text: "HTTP endpoints",
          }}
        />
        <PageAccessories>
          <LinkButton
            variant={"minimal/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("documentation/concepts/http-endpoints")}
          >
            HTTP endpoints documentation
          </LinkButton>
        </PageAccessories>

        {httpEndpoint.webhook && (
          <PageInfoRow>
            <PageInfoGroup>
              <PageInfoProperty
                icon="webhook"
                label="Webhook Trigger"
                to={httpEndpoint.webhookLink}
              />
            </PageInfoGroup>
          </PageInfoRow>
        )}
      </NavBar>
      <PageBody>
        <Help defaultOpen={true}>
          {(open) => (
            <div className={cn("grid h-full gap-4", open ? "grid-cols-2" : "grid-cols-1")}>
              <div>
                <div className="mb-2 flex items-center justify-between gap-x-2">
                  <Header1 spacing>
                    {httpEndpoint.httpEndpointEnvironments.length > 0
                      ? "Ready to receive data"
                      : "Not deployed"}
                  </Header1>
                  <HelpTrigger title="How do I connect my HTTP Endpoint?" />
                </div>
                {httpEndpoint.httpEndpointEnvironments.length > 0 && (
                  <div className="mb-8">
                    <Table fullWidth>
                      <TableHeader>
                        <TableHeaderCell>Environment</TableHeaderCell>
                        <TableHeaderCell>Endpoint URL</TableHeaderCell>
                        <TableHeaderCell>Secret</TableHeaderCell>
                        <TableHeaderCell>Source</TableHeaderCell>
                        <TableHeaderCell>Respond to request?</TableHeaderCell>
                        <TableHeaderCell alignment="right">Updated</TableHeaderCell>
                      </TableHeader>
                      <TableBody>
                        {httpEndpoint.httpEndpointEnvironments.map((httpEnvironment) => {
                          return (
                            <TableRow key={httpEnvironment.id}>
                              <TableCell>
                                <EnvironmentLabel environment={httpEnvironment.environment} />
                              </TableCell>
                              <TableCell>
                                <ClipboardField
                                  className="max-w-[30rem]"
                                  fullWidth={false}
                                  value={httpEnvironment?.webhookUrl ?? ""}
                                  variant="tertiary/small"
                                />
                              </TableCell>
                              <TableCell>
                                <ClipboardField
                                  className="max-w-[10rem]"
                                  fullWidth={false}
                                  value={secret}
                                  secure
                                  variant={"tertiary/small"}
                                />
                              </TableCell>
                              <TableCell>{httpEnvironment.source}</TableCell>
                              <TableCell>
                                {httpEnvironment.immediateResponseFilter ? (
                                  <CheckIcon className="h-4 w-4 text-charcoal-400" />
                                ) : (
                                  <StopIcon className="h-4 w-4 text-charcoal-850" />
                                )}
                              </TableCell>
                              <TableCell alignment="right">
                                <DateTime date={httpEnvironment.updatedAt} />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {unconfiguredEnvironments.length > 0 && (
                  <>
                    <Header1 spacing>Not deployed</Header1>
                    <Paragraph spacing variant="small">
                      You need to deploy your code for the following environments to receive
                      webhooks –{" "}
                      <TextLink to={docsPath("documentation/guides/deployment")}>
                        read our deployment guide
                      </TextLink>
                      .
                    </Paragraph>
                    <div className="mb-8">
                      <Table fullWidth>
                        <TableHeader>
                          <TableRow>
                            <TableHeaderCell>Environment</TableHeaderCell>
                            <TableHeaderCell>Endpoint URL</TableHeaderCell>
                            <TableHeaderCell>Secret</TableHeaderCell>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {unconfiguredEnvironments.map((environment) => {
                            return (
                              <TableRow key={environment.id}>
                                <TableCell>
                                  <EnvironmentLabel
                                    environment={environment}
                                    className="opacity-50"
                                  />
                                </TableCell>
                                <TableCell>
                                  <ClipboardField
                                    className="max-w-[30rem]"
                                    fullWidth={false}
                                    value={environment?.webhookUrl ?? ""}
                                    variant="tertiary/small"
                                  />
                                </TableCell>
                                <TableCell>
                                  <ClipboardField
                                    className="max-w-[10rem]"
                                    fullWidth={false}
                                    value={secret}
                                    secure
                                    variant={"tertiary/small"}
                                  />
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </div>
              <HelpContent title="How to connect my HTTP Endpoint">
                <HowToConnectHttpEndpoint />
              </HelpContent>
            </div>
          )}
        </Help>
      </PageBody>
    </PageContainer>
  );
}
