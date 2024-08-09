import { BookOpenIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, UseDataFunctionReturn, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useOrganization } from "~/hooks/useOrganizations";
import { useTextFilter } from "~/hooks/useTextFilter";
import { ConcurrencyPresenter } from "~/presenters/v3/ConcurrencyPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, docsPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new ConcurrencyPresenter();
    const { environments, tasks } = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typedjson({
      environments,
      tasks,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

type Task = UseDataFunctionReturn<typeof loader>["tasks"][0];

export default function Page() {
  const { environments, tasks } = useTypedLoaderData<typeof loader>();
  const { filterText, setFilterText, filteredItems } = useTextFilter<Task>({
    items: tasks,
    filter: (task, text) => {
      if (task.identifier.toLowerCase().includes(text.toLowerCase())) {
        return true;
      }

      if (task.triggerSource === "SCHEDULED" && "scheduled".includes(text.toLowerCase())) {
        return true;
      }

      return false;
    },
  });

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Concurrency" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {environments.map((environment) => (
                <Property.Item key={environment.id}>
                  <Property.Label>{environment.slug}</Property.Label>
                  <Property.Value>{environment.id}</Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>

          <LinkButton
            variant={"minimal/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/queue-concurrency")}
          >
            Concurrency docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className="mt-1 flex flex-col gap-4">
          <div>
            <Header2 spacing>Environments</Header2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Environment</TableHeaderCell>
                  <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                  <TableHeaderCell alignment="right">Running</TableHeaderCell>
                  <TableHeaderCell alignment="right">Concurrency limit</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {environments.map((environment) => (
                  <TableRow key={environment.id}>
                    <TableCell>
                      <EnvironmentLabel environment={environment} userName={environment.userName} />
                    </TableCell>
                    <TableCell alignment="right">–</TableCell>
                    <TableCell alignment="right">{environment.concurrency}</TableCell>
                    <TableCell alignment="right">{environment.concurrencyLimit}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <Header2 spacing>Tasks</Header2>
            <div className="h-8">
              <Input
                placeholder="Search tasks"
                variant="tertiary"
                icon="search"
                fullWidth={true}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                autoFocus
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Task ID</TableHeaderCell>
                  <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                  <TableHeaderCell alignment="right">Running</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.length > 0 ? (
                  filteredItems.map((task) => (
                    <TableRow key={task.identifier}>
                      <TableCell>{task.identifier}</TableCell>
                      <TableCell alignment="right">–</TableCell>
                      <TableCell alignment="right">{task.concurrency}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableBlankRow colSpan={3}>
                    <Paragraph variant="small" className="flex items-center justify-center">
                      {tasks.length > 0 ? "No tasks match your filters" : "No tasks"}
                    </Paragraph>
                  </TableBlankRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
