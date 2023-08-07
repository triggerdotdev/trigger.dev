import { useRevalidator } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { useEffect, useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { HowToUseApiKeysAndEndpoints } from "~/components/helpContent/HelpContentText";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { ButtonContent } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import {
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
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { ClientEndpoint, EnvironmentsPresenter } from "~/presenters/EnvironmentsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import { ProjectParamSchema, projectEnvironmentsStreamingPath } from "~/utils/pathBuilder";
import { requestUrl } from "~/utils/requestUrl.server";
import { RuntimeEnvironmentType } from "../../../../../packages/database/src";
import { ConfigureEndpointSheet } from "./ConfigureEndpointSheet";
import { Badge } from "~/components/primitives/Badge";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const url = requestUrl(request);
    const baseUrl = `${url.protocol}//${url.host}`;
    const presenter = new EnvironmentsPresenter();
    const { environments, clients } = await presenter.call({
      userId,
      projectSlug: projectParam,
      baseUrl,
    });

    return typedjson({
      environments,
      clients,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Environments" />,
  expandSidebar: true,
};

export default function Page() {
  const { environments, clients } = useTypedLoaderData<typeof loader>();
  const [selected, setSelected] = useState<
    { client: string; type: RuntimeEnvironmentType } | undefined
  >();

  const selectedEndpoint = useMemo(() => {
    if (!selected) return undefined;

    const client = clients.find((c) => c.slug === selected.client);
    if (!client) return undefined;

    if (selected.type === "PREVIEW" || selected.type === "STAGING") {
      throw new Error("PREVIEW/STAGING is not yet supported");
    }

    return {
      clientSlug: selected.client,
      type: selected.type,
      endpoint: client.endpoints[selected.type],
    };
  }, [selected, clients]);

  const isAnyClientFullyConfigured = useMemo(() => {
    return clients.some((client) => {
      const { DEVELOPMENT, PRODUCTION } = client.endpoints;
      return PRODUCTION.state === "configured" && DEVELOPMENT.state === PRODUCTION.state;
    });
  }, [clients]);

  const organization = useOrganization();
  const project = useProject();

  const revalidator = useRevalidator();
  const events = useEventSource(projectEnvironmentsStreamingPath(organization, project), {
    event: "message",
  });

  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Environments & API Keys" />
        </PageTitleRow>
        <PageDescription>API Keys and endpoints for your environments.</PageDescription>
      </PageHeader>
      <PageBody>
        <Help defaultOpen={!isAnyClientFullyConfigured}>
          {(open) => (
            <div className={cn("grid h-full gap-4", open ? "grid-cols-2" : "grid-cols-1")}>
              <div>
                <div className="mb-2 flex items-center justify-between gap-x-2">
                  <Header2>API Keys</Header2>
                  <HelpTrigger title="How do I use API Keys and Endpoints?" />
                </div>
                <div className="mb-8">
                  <Paragraph variant="small" spacing>
                    Server API keys should be used on your server – they give full API access.{" "}
                    <br />
                    Public API keys should be used in your frontend – they have limited read-only
                    access.
                  </Paragraph>
                  <div className="mt-4 flex flex-col gap-6">
                    {environments.map((environment) => (
                      <div key={environment.id}>
                        <Header3 className="flex items-center gap-1">
                          <EnvironmentLabel environment={environment} /> Environment
                        </Header3>
                        <div className="mt-2 inline-flex flex-col gap-3">
                          <ClipboardField
                            className="w-full max-w-none"
                            secure
                            value={environment.apiKey}
                            variant={"primary/medium"}
                            icon={<Badge variant="outline">Server</Badge>}
                          />
                          <ClipboardField
                            className="w-full max-w-none"
                            value={environment.pkApiKey}
                            variant={"primary/medium"}
                            icon={<Badge variant="outline">Public</Badge>}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <Header2 className="mb-2">Endpoints</Header2>
                <div className="flex flex-col gap-4">
                  {clients.length > 0 ? (
                    clients.map((client) => (
                      <div key={client.slug}>
                        <Header3 className="mb-2">{client.slug}</Header3>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>Environment</TableHeaderCell>
                              <TableHeaderCell>Url</TableHeaderCell>
                              <TableHeaderCell>Last refreshed</TableHeaderCell>
                              <TableHeaderCell>Jobs</TableHeaderCell>
                              <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <EndpointRow
                              endpoint={client.endpoints.DEVELOPMENT}
                              type="DEVELOPMENT"
                              onClick={() =>
                                setSelected({
                                  client: client.slug,
                                  type: "DEVELOPMENT",
                                })
                              }
                            />
                            <EndpointRow
                              endpoint={client.endpoints.PRODUCTION}
                              type="PRODUCTION"
                              onClick={() =>
                                setSelected({
                                  client: client.slug,
                                  type: "PRODUCTION",
                                })
                              }
                            />
                          </TableBody>
                        </Table>
                      </div>
                    ))
                  ) : (
                    <Paragraph>You have no clients yet</Paragraph>
                  )}
                </div>
                {selectedEndpoint && (
                  <ConfigureEndpointSheet
                    slug={selectedEndpoint.clientSlug}
                    endpoint={selectedEndpoint.endpoint}
                    type={selectedEndpoint.type}
                    onClose={() => setSelected(undefined)}
                  />
                )}
              </div>
              <HelpContent title="How to use API Keys and Endpoints">
                <HowToUseApiKeysAndEndpoints />
              </HelpContent>
            </div>
          )}
        </Help>
      </PageBody>
    </PageContainer>
  );
}

function EndpointRow({
  endpoint,
  type,
  onClick,
}: {
  endpoint: ClientEndpoint;
  type: RuntimeEnvironmentType;
  onClick?: () => void;
}) {
  switch (endpoint.state) {
    case "unconfigured":
      return (
        <TableRow>
          <TableCell onClick={onClick}>
            <div className="flex">
              <EnvironmentLabel environment={{ type }} />
            </div>
          </TableCell>
          <TableCell onClick={onClick} colSpan={4} alignment="right">
            <div className="flex items-center justify-end gap-4">
              <span className="text-amber-500">
                The {environmentTitle({ type })} environment is not configured
              </span>
              <ButtonContent variant="primary/small">Configure</ButtonContent>
            </div>
          </TableCell>
        </TableRow>
      );
    case "configured":
      return (
        <TableRow>
          <TableCell onClick={onClick}>
            <div className="flex">
              <EnvironmentLabel environment={{ type }} />
            </div>
          </TableCell>
          <TableCell onClick={onClick}>{endpoint.url}</TableCell>
          <TableCell onClick={onClick}>
            {endpoint.latestIndex ? <DateTime date={endpoint.latestIndex.updatedAt} /> : "–"}
          </TableCell>
          <TableCell onClick={onClick}>{endpoint.latestIndex?.stats.jobs ?? "–"}</TableCell>
          <TableCellChevron onClick={onClick} />
        </TableRow>
      );
  }
}
