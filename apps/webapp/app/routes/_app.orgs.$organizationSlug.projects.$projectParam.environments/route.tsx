import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ClipboardField } from "~/components/ClipboardField";
import {
  EnvironmentLabel,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
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
import { useProject } from "~/hooks/useProject";
import {
  ClientEndpoint,
  EnvironmentsPresenter,
} from "~/presenters/EnvironmentsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { ProjectParamSchema } from "~/utils/pathBuilder";
import { RuntimeEnvironmentType } from "../../../../../packages/database/src";
import { formatDateTime } from "~/utils";
import { Button, ButtonContent } from "~/components/primitives/Buttons";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new EnvironmentsPresenter();
    const { environments, clients } = await presenter.call({
      userId,
      slug: projectParam,
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

        <Header1>Clients</Header1>
        {clients.length > 0 ? (
          clients.map((client) => (
            <div key={client.slug}>
              <Header2>{client.slug}</Header2>
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
                    onClick={() => console.log("click")}
                  />
                  <EndpointRow
                    endpoint={client.endpoints.STAGING}
                    type="STAGING"
                    onClick={() => console.log("click")}
                  />
                  <EndpointRow
                    endpoint={client.endpoints.PRODUCTION}
                    type="PRODUCTION"
                    onClick={() => console.log("click")}
                  />
                </TableBody>
              </Table>
            </div>
          ))
        ) : (
          <Paragraph>You have no clients yet</Paragraph>
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
                {environmentTitle({ type })} environment is not configured
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
