import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { env } from "process";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import {
  PageButtons,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import { ProjectParamSchema, docsPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new EnvironmentVariablesPresenter();
    const { environmentVariables, environments } = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typedjson({
      environmentVariables,
      environments,
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
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Environments & API Keys" />,
};

export default function Page() {
  const { environmentVariables, environments } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Environment variables" />
          <PageButtons>
            <LinkButton
              LeadingIcon={"docs"}
              to={docsPath("/documentation/concepts/environments-endpoints#environments")}
              variant="secondary/small"
            >
              Environment variables docs
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <div className={cn("h-full")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Key</TableHeaderCell>
                {environments.map((environment) => (
                  <TableHeaderCell key={environment.id}>
                    <EnvironmentLabel environment={environment} />
                  </TableHeaderCell>
                ))}
                <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {environmentVariables.length > 0 ? (
                environmentVariables.map((variable) => (
                  <TableRow key={variable.id}>
                    <TableCell>{variable.key}</TableCell>
                    {environments.map((environment) => {
                      const value = variable.values[environment.id]?.value;

                      if (!value) {
                        return <TableCell key={environment.id}>Not set</TableCell>;
                      }
                      return (
                        <TableCell key={environment.id}>
                          <ClipboardField
                            className="w-full max-w-none"
                            secure
                            value={value}
                            variant={"tertiary/small"}
                          />
                        </TableCell>
                      );
                    })}

                    <TableCellMenu isSticky></TableCellMenu>
                  </TableRow>
                ))
              ) : (
                <TableCell colSpan={environments.length + 2}>
                  <div className="flex items-center justify-center">
                    <Paragraph>No environment variables have been set</Paragraph>
                  </div>
                </TableCell>
              )}
            </TableBody>
          </Table>
        </div>
      </PageBody>
    </PageContainer>
  );
}
