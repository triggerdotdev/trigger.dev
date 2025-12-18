import { Form, useNavigation } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { TSQLEditor } from "~/components/code/TSQLEditor";
import { TSQLResultsTable } from "~/components/code/TSQLResultsTable";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { executeQuery } from "~/services/queryService.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { defaultQuery, querySchemas } from "~/v3/querySchemas";

const scopeOptions = [
  { value: "environment", label: "Environment" },
  { value: "project", label: "Project" },
  { value: "organization", label: "Organization" },
] as const;

type QueryScope = (typeof scopeOptions)[number]["value"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (!user.admin) {
    throw redirect("/");
  }

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  return typedjson({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    defaultQuery,
  });
};

const ActionSchema = z.object({
  query: z.string().min(1, "Query is required"),
  scope: z.enum(["environment", "project", "organization"]),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  // Temporarily admin-only
  if (!user.admin) {
    return typedjson({ error: "Unauthorized", rows: null, columns: null }, { status: 403 });
  }

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    return typedjson({ error: "Project not found", rows: null, columns: null }, { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    return typedjson(
      { error: "Environment not found", rows: null, columns: null },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const parsed = ActionSchema.safeParse({
    query: formData.get("query"),
    scope: formData.get("scope"),
  });

  if (!parsed.success) {
    return typedjson(
      { error: parsed.error.errors.map((e) => e.message).join(", "), rows: null, columns: null },
      { status: 400 }
    );
  }

  const { query, scope } = parsed.data;

  // Build tenant IDs based on scope
  const tenantOptions: {
    organizationId: string;
    projectId?: string;
    environmentId?: string;
  } = {
    organizationId: project.organizationId,
  };

  if (scope === "project" || scope === "environment") {
    tenantOptions.projectId = project.id;
  }

  if (scope === "environment") {
    tenantOptions.environmentId = environment.id;
  }

  try {
    const [error, result] = await executeQuery({
      name: "query-page",
      query,
      schema: z.record(z.any()),
      tableSchema: querySchemas,
      transformValues: true,
      ...tenantOptions,
    });

    if (error) {
      return typedjson({ error: error.message, rows: null, columns: null }, { status: 400 });
    }

    return typedjson({ error: null, rows: result.rows, columns: result.columns });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error executing query";
    return typedjson({ error: errorMessage, rows: null, columns: null }, { status: 500 });
  }
};

export default function Page() {
  const { defaultQuery } = useTypedLoaderData<typeof loader>();
  const results = useTypedActionData<typeof action>();
  const navigation = useNavigation();

  const [query, setQuery] = useState(defaultQuery);
  const [scope, setScope] = useState<QueryScope>("environment");

  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Query" />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid grid-rows-[1fr_auto]">
          {/* Query editor */}
          <div className="flex h-full flex-col gap-2 pb-2">
            <TSQLEditor
              defaultValue={query}
              onChange={setQuery}
              schema={querySchemas}
              linterEnabled={true}
              showCopyButton={true}
              showClearButton={true}
              minHeight="200px"
              className="min-h-[200px]"
            />
            <Form method="post" className="flex items-center justify-end gap-3 px-2">
              <input type="hidden" name="query" value={query} />
              <input type="hidden" name="scope" value={scope} />
              <Select
                value={scope}
                setValue={(value) => setScope(value as QueryScope)}
                variant="tertiary/small"
                dropdownIcon={true}
                items={[...scopeOptions]}
                text={(value) => {
                  return <ScopeItem scope={value as QueryScope} />;
                }}
              >
                {(items) =>
                  items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      <ScopeItem scope={item.value as QueryScope} />
                    </SelectItem>
                  ))
                }
              </Select>
              <Button
                type="submit"
                variant="primary/small"
                disabled={isLoading || !query.trim()}
                shortcut={{ modifiers: ["mod"], key: "enter", enabledOnInputElements: true }}
                LeadingIcon={isLoading ? <Spinner className="size-4" color="white" /> : undefined}
              >
                {isLoading ? "Querying..." : "Query"}
              </Button>
            </Form>
          </div>
          {/* Results */}
          <div className="grid h-full min-h-0 flex-1 grid-rows-[2.5rem_1fr] flex-col gap-2 border-t border-grid-dimmed pt-1">
            <div className="px-3">
              <Header2>
                {results?.rows?.length ? `${results.rows.length} Results` : "Results"}
              </Header2>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-grid-dimmed bg-charcoal-900">
              {isLoading ? (
                <div className="flex items-center gap-2 p-4 text-text-dimmed">
                  <Spinner className="size-4" />
                  <span>Executing query...</span>
                </div>
              ) : results?.error ? (
                <pre className="whitespace-pre-wrap p-4 text-sm text-red-400">{results.error}</pre>
              ) : results?.rows && results?.columns ? (
                <TSQLResultsTable rows={results.rows} columns={results.columns} />
              ) : (
                <Paragraph variant="small" className="p-4 text-text-dimmed">
                  Run a query to see results here.
                </Paragraph>
              )}
            </div>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function ScopeItem({ scope }: { scope: QueryScope }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  switch (scope) {
    case "organization":
      return organization.title;
    case "project":
      return project.name;
    case "environment":
      return <EnvironmentLabel environment={environment} />;
    default:
      return scope;
  }
}
