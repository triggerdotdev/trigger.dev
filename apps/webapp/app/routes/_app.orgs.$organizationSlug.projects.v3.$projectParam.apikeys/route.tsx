import { BookOpenIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { PageAccessories, NavBar, PageTitle } from "~/components/primitives/PageHeader";
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
import { useProject } from "~/hooks/useProject";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, docsPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new ApiKeysPresenter();
    const { environments } = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typedjson({
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

export default function Page() {
  const { environments } = useTypedLoaderData<typeof loader>();
  const project = useProject();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="API Keys" />
        <PageAccessories>
          <LinkButton
            variant={"minimal/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/documentation/concepts/environments-endpoints#environments")}
          >
            API keys docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className={cn("h-full")}>
          <Header3 spacing>Server API keys</Header3>
          <Paragraph variant="small" spacing>
            Server API keys should be used on your server – they give full API access.
          </Paragraph>
          <Header3 spacing>Public API keys</Header3>
          <Paragraph variant="small" spacing>
            These keys have limited read-only access and should be used in your frontend.
          </Paragraph>
          <div className="mt-4 flex flex-col gap-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Environment</TableHeaderCell>
                  <TableHeaderCell>Server API key</TableHeaderCell>
                  <TableHeaderCell>Public API key</TableHeaderCell>
                  <TableHeaderCell>Keys generated</TableHeaderCell>
                  <TableHeaderCell>Latest version</TableHeaderCell>
                  <TableHeaderCell>Env vars</TableHeaderCell>
                  <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {environments.map((environment) => (
                  <TableRow key={environment.id}>
                    <TableCell>
                      <EnvironmentLabel environment={environment} />
                    </TableCell>
                    <TableCell>
                      <ClipboardField
                        className="w-full max-w-none"
                        secure={`tr_${environment.apiKey.split("_")[1]}_••••••••`}
                        value={environment.apiKey}
                        variant={"tertiary/small"}
                      />
                    </TableCell>
                    <TableCell>
                      <ClipboardField
                        className="w-full max-w-none"
                        value={environment.pkApiKey}
                        variant={"tertiary/small"}
                      />
                    </TableCell>
                    <TableCell>
                      <DateTime date={environment.updatedAt} />
                    </TableCell>
                    <TableCell>{environment.latestVersion ?? "–"}</TableCell>
                    <TableCell>{environment.environmentVariableCount}</TableCell>
                    <TableCellMenu isSticky>
                      <RegenerateApiKeyModal
                        id={environment.id}
                        title={environmentTitle(environment)}
                      />
                    </TableCellMenu>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
