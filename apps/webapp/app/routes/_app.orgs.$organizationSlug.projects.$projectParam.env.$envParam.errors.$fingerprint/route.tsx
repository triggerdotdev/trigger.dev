import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type MetaFunction, Link } from "@remix-run/react";
import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema, v3ErrorsPath, v3RunPath } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  ErrorGroupPresenter,
  type ErrorInstance,
} from "~/presenters/v3/ErrorGroupPresenter.server";
import { $replica } from "~/db.server";
import { logsClickhouseClient } from "~/services/clickhouseInstance.server";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Suspense } from "react";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { Button } from "~/components/primitives/Buttons";
import { Badge } from "~/components/primitives/Badge";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { formatDistanceToNow } from "date-fns";
import { cn } from "~/utils/cn";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  return [
    {
      title: `Error Details | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);
  const fingerprint = params.fingerprint;

  if (!fingerprint) {
    throw new Response("Fingerprint parameter is required", { status: 400 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const presenter = new ErrorGroupPresenter($replica, logsClickhouseClient);

  const detailPromise = presenter
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      fingerprint,
    })
    .catch((error) => {
      if (error instanceof ServiceValidationError) {
        return { error: error.message };
      }
      throw error;
    });

  return typeddefer({
    data: detailPromise,
    organizationSlug,
    projectParam,
    envParam,
    fingerprint,
  });
};

export default function Page() {
  const { data, organizationSlug, projectParam, envParam } = useTypedLoaderData<typeof loader>();

  const errorsPath = v3ErrorsPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam }
  );

  return (
    <PageContainer>
      <NavBar>
        <div className="flex items-center gap-2">
          <Link to={errorsPath}>
            <Button variant="tertiary/small" LeadingIcon={ArrowLeftIcon}>
              Back to Errors
            </Button>
          </Link>
          <PageTitle title="Error Details" />
        </div>
      </NavBar>

      <PageBody scrollable={false}>
        <Suspense
          fallback={
            <div className="my-2 flex items-center justify-center">
              <div className="mx-auto flex items-center gap-2">
                <Spinner />
                <Paragraph variant="small">Loading error details…</Paragraph>
              </div>
            </div>
          }
        >
          <TypedAwait
            resolve={data}
            errorElement={
              <div className="flex items-center justify-center px-3 py-12">
                <Callout variant="error" className="max-w-fit">
                  Unable to load error details. Please refresh the page or try again in a moment.
                </Callout>
              </div>
            }
          >
            {(result) => {
              // Check if result contains an error
              if ("error" in result) {
                return (
                  <div className="flex items-center justify-center px-3 py-12">
                    <Callout variant="error" className="max-w-fit">
                      {result.error}
                    </Callout>
                  </div>
                );
              }
              return (
                <ErrorGroupDetail
                  errorGroup={result.errorGroup}
                  instances={result.instances}
                  organizationSlug={organizationSlug}
                  projectParam={projectParam}
                  envParam={envParam}
                />
              );
            }}
          </TypedAwait>
        </Suspense>
      </PageBody>
    </PageContainer>
  );
}

function ErrorGroupDetail({
  errorGroup,
  instances,
  organizationSlug,
  projectParam,
  envParam,
}: {
  errorGroup:
    | {
        errorType: string;
        errorMessage: string;
        stackTrace?: string;
      }
    | undefined;
  instances: ErrorInstance[];
  organizationSlug: string;
  projectParam: string;
  envParam: string;
}) {
  if (!errorGroup) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Header3 className="mb-2">Error not found</Header3>
          <Paragraph variant="small">
            This error group does not exist or has no instances.
          </Paragraph>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Error Summary */}
      <div className="border-b border-grid-bright bg-charcoal-850 p-6">
        <div className="mb-4">
          <Badge variant="default" className="mb-2">
            {errorGroup.errorType}
          </Badge>
          <Header2 className="mb-4">{errorGroup.errorMessage}</Header2>
        </div>

        {errorGroup.stackTrace && (
          <div className="rounded-md bg-charcoal-900 p-4">
            <Paragraph variant="small" className="mb-2 font-semibold text-text-bright">
              Stack Trace
            </Paragraph>
            <pre className="overflow-x-auto text-xs text-text-dimmed">
              <code>{errorGroup.stackTrace}</code>
            </pre>
          </div>
        )}
      </div>

      {/* Instances List */}
      <div className="p-6">
        <Header3 className="mb-4">Error Instances ({instances.length.toLocaleString()})</Header3>

        {instances.length === 0 ? (
          <Callout variant="info">No error instances found.</Callout>
        ) : (
          <div className="space-y-3">
            {instances.map((instance) => (
              <ErrorInstanceRow
                key={instance.runId}
                instance={instance}
                organizationSlug={organizationSlug}
                projectParam={projectParam}
                envParam={envParam}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorInstanceRow({
  instance,
  organizationSlug,
  projectParam,
  envParam,
}: {
  instance: ErrorInstance;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
}) {
  const runPath = v3RunPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
    { friendlyId: instance.friendlyId }
  );

  return (
    <Link
      to={runPath}
      className={cn(
        "block rounded-md border border-grid-dimmed p-4 transition hover:border-grid-bright hover:bg-charcoal-800"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <Paragraph className="font-mono font-semibold">{instance.friendlyId}</Paragraph>
            <Badge variant="outline-rounded">{instance.status}</Badge>
          </div>
          <Paragraph variant="small" className="mb-1 text-text-dimmed">
            Task: <span className="font-mono">{instance.taskIdentifier}</span>
          </Paragraph>
          <Paragraph variant="extra-small" className="text-text-dimmed">
            {formatDistanceToNow(instance.createdAt, { addSuffix: true })} • Version:{" "}
            {instance.taskVersion}
          </Paragraph>
        </div>
      </div>

      {/* Show error details if available */}
      {instance.error && typeof instance.error === "object" && "message" in instance.error && (
        <div className="mt-3 rounded border border-grid-dimmed bg-charcoal-900 p-3">
          <Paragraph variant="extra-small" className="font-mono text-text-dimmed">
            {String(instance.error.message)}
          </Paragraph>
        </div>
      )}
    </Link>
  );
}
