import { CircleStackIcon } from "@heroicons/react/20/solid";
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
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
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
    return typedjson({ error: "Unauthorized", rows: null }, { status: 403 });
  }

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    return typedjson({ error: "Project not found", rows: null }, { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    return typedjson({ error: "Environment not found", rows: null }, { status: 404 });
  }

  const formData = await request.formData();
  const parsed = ActionSchema.safeParse({
    query: formData.get("query"),
    scope: formData.get("scope"),
  });

  if (!parsed.success) {
    return typedjson(
      { error: parsed.error.errors.map((e) => e.message).join(", "), rows: null },
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
    const [error, rows] = await executeQuery({
      name: "query-page",
      query,
      schema: z.record(z.any()),
      tableSchema: querySchemas,
      transformValues: false,
      ...tenantOptions,
    });

    if (error) {
      return typedjson({ error: error.message, rows: null }, { status: 400 });
    }

    return typedjson({ error: null, rows });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error executing query";
    return typedjson({ error: errorMessage, rows: null }, { status: 500 });
  }
};

export default function Page() {
  const { organizationId, projectId, environmentId, defaultQuery } =
    useTypedLoaderData<typeof loader>();
  const actionData = useTypedActionData<typeof action>();
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
        <div className="flex h-full flex-col gap-4 p-4">
          {/* Editor */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Header2>SQL Query</Header2>
              <Paragraph variant="small" className="text-text-dimmed">
                Query task runs using SQL. Results are scoped to your selected tenant level.
              </Paragraph>
            </div>
            <div className="overflow-hidden rounded-lg border border-grid-dimmed">
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
            </div>
          </div>

          {/* Controls */}
          <Form method="post" className="flex items-center gap-3">
            <input type="hidden" name="query" value={query} />
            <input type="hidden" name="scope" value={scope} />

            <div className="flex items-center gap-2">
              <Paragraph variant="small" className="text-text-dimmed">
                Scope:
              </Paragraph>
              <Select<QueryScope, (typeof scopeOptions)[number]>
                value={scope}
                setValue={(value) => setScope(value as QueryScope)}
                variant="secondary/small"
                dropdownIcon={true}
                items={[...scopeOptions]}
              >
                {(items) =>
                  items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))
                }
              </Select>
            </div>

            <Button
              type="submit"
              variant="primary/medium"
              disabled={isLoading || !query.trim()}
              shortcut={{ modifiers: ["mod"], key: "enter", enabledOnInputElements: true }}
            >
              {isLoading ? (
                <>
                  <Spinner className="size-4" color="white" />
                  Querying...
                </>
              ) : (
                "Query"
              )}
            </Button>
          </Form>

          {/* Results */}
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <Header2>Results</Header2>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-grid-dimmed bg-charcoal-900 p-4">
              {isLoading ? (
                <div className="flex items-center gap-2 text-text-dimmed">
                  <Spinner className="size-4" />
                  <span>Executing query...</span>
                </div>
              ) : actionData?.error ? (
                <pre className="whitespace-pre-wrap text-sm text-red-400">{actionData.error}</pre>
              ) : actionData?.rows ? (
                <pre className="whitespace-pre-wrap text-sm text-text-bright">
                  {JSON.stringify(actionData.rows, null, 2)}
                </pre>
              ) : (
                <Paragraph variant="small" className="text-text-dimmed">
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
