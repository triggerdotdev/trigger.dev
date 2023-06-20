import { LoaderArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ClipboardField } from "~/components/ClipboardField";
import {
  EnvironmentLabel,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { ButtonContent } from "~/components/primitives/Buttons";
import { Header1, Header2 } from "~/components/primitives/Headers";
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
import {
  ClientEndpoint,
  EnvironmentsPresenter,
} from "~/presenters/EnvironmentsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { Handle } from "~/utils/handle";
import { ProjectParamSchema } from "~/utils/pathBuilder";
import { RuntimeEnvironmentType } from "../../../../../packages/database/src";
import { ConfigureEndpointSheet } from "./ConfigureEndpointSheet";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const url = new URL(request.url);
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
      statusText:
        "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const handle: Handle = {
  breadcrumb: {
    slug: "environments",
  },
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

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Environments & API Keys" />
        </PageTitleRow>
        <PageDescription>
          API Keys and endpoints for your environments.
        </PageDescription>
      </PageHeader>
      <PageBody>
        <Header1>API Keys</Header1>
        <div className="mb-8 mt-4 flex gap-4">
          {environments.map((environment) => (
            <ClipboardField
              key={environment.id}
              secure
              value={environment.apiKey}
              variant={"primary/medium"}
              icon={<EnvironmentLabel environment={environment} />}
            />
          ))}
        </div>

        <Header1 className="mb-2">Clients</Header1>
        <div className="flex flex-col gap-4">
          {clients.length > 0 ? (
            clients.map((client) => (
              <div key={client.slug}>
                <Header2 className="mb-2">{client.slug}</Header2>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Environment</TableHeaderCell>
                      <TableHeaderCell>Last refreshed</TableHeaderCell>
                      <TableHeaderCell>Jobs</TableHeaderCell>
                      <TableHeaderCell>Url</TableHeaderCell>
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
              <span className="text-rose-500">
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
          <TableCell onClick={onClick}>
            {endpoint.latestIndex
              ? formatDateTime(endpoint.latestIndex.updatedAt)
              : "–"}
          </TableCell>
          <TableCell onClick={onClick}>
            {endpoint.latestIndex?.stats.jobs ?? "–"}
          </TableCell>
          <TableCell onClick={onClick}>{endpoint.url}</TableCell>
          <TableCellChevron onClick={onClick} />
        </TableRow>
      );
  }
}
