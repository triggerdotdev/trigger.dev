import { ClipboardDocumentCheckIcon } from "@heroicons/react/24/outline";
import { useRevalidator } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import {
  typedjson,
  UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { CopyText } from "~/components/CopyText";
import { Container } from "~/components/layout/Container";
import { Header1 } from "~/components/primitives/text/Headers";
import { WorkflowList } from "~/components/workflows/workflowList";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import { OrganizationTemplatePresenter } from "~/presenters/organizationTemplatePresenter.server";

export async function loader({ params, request }: LoaderArgs) {
  const currentEnv = await getRuntimeEnvironmentFromRequest(request);

  const presenter = new OrganizationTemplatePresenter();

  return typedjson(
    await presenter.data(params.templateId as string, currentEnv)
  );
}

type LoaderData = UseDataFunctionReturn<typeof loader>;

export default function TemplatePage() {
  const loaderData = useTypedLoaderData<typeof loader>();

  const events = useEventSource(
    `/resources/organizationTemplates/${loaderData.organizationTemplate.id}`
  );
  const revalidator = useRevalidator();

  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
  }, [events]);

  const organizationTemplateByStatus = (
    <OrganizationTemplateByStatus {...loaderData} />
  );

  return (
    <Container>
      <Header1>{loaderData.organizationTemplate.template.title}</Header1>
      <br />

      {organizationTemplateByStatus}
    </Container>
  );
}

function OrganizationTemplateByStatus(loaderData: LoaderData) {
  if (
    loaderData.organizationTemplate.status === "PENDING" ||
    loaderData.organizationTemplate.status === "CREATED"
  ) {
    return (
      <div className="flex justify-center">
        <div className="h-32 w-32 animate-spin rounded-full border-b-2 border-slate-50"></div>
      </div>
    );
  }

  return <OrganizationTemplateReady {...loaderData} />;
}

function OrganizationTemplateReady(loaderData: LoaderData) {
  return (
    <div>
      <p>Organization Template ready to deploy</p>
      <TemplateHeader organizationTemplate={loaderData.organizationTemplate} />

      <DeploySection {...loaderData} />
    </div>
  );
}

function TemplateHeader({
  organizationTemplate,
}: {
  organizationTemplate: LoaderData["organizationTemplate"];
}) {
  return (
    <dl className="space-y-2">
      <dt className="font-bold">Repo URL</dt>
      <dd>
        <a href={organizationTemplate.repositoryUrl} target="_blank">
          {organizationTemplate.repositoryUrl}
        </a>
      </dd>

      <dt className="font-bold">Is Private</dt>
      <dd>{organizationTemplate.private ? "Yes" : "No"}</dd>
    </dl>
  );
}

function DeploySection({
  organizationTemplate,
  apiKey,
  workflows,
}: {
  organizationTemplate: LoaderData["organizationTemplate"];
  apiKey: string;
  workflows: LoaderData["workflows"];
}) {
  const currentOrganization = useCurrentOrganization();

  if (!currentOrganization) {
    return null;
  }

  if (organizationTemplate.status === "READY_TO_DEPLOY") {
    return (
      <>
        <a
          href={`https://render.com/deploy?repo=${organizationTemplate.repositoryUrl}`}
          target="_blank"
        >
          <img
            src="https://render.com/images/deploy-to-render-button.svg"
            alt="Deploy to Render"
          />
        </a>
        <div className="flex justify-center">
          <div className="h-32 w-32 animate-spin rounded-full border-b-2 border-slate-50"></div>
        </div>
        <div className="relative select-all overflow-hidden rounded-sm border border-slate-800 p-1 pl-2 text-sm text-slate-400">
          <span className="pointer-events-none absolute right-7 top-0 block h-6 w-20 bg-gradient-to-r from-transparent to-slate-950"></span>
          <CopyText
            value={apiKey}
            className="group absolute right-0 top-0 flex h-full w-7 items-center justify-center rounded-sm border-l border-slate-800 bg-slate-950 transition hover:cursor-pointer hover:bg-slate-900 active:bg-green-900"
          >
            <ClipboardDocumentCheckIcon className="h-5 w-5 group-active:text-green-500" />
          </CopyText>
          {apiKey}
        </div>
      </>
    );
  } else {
    return (
      <>
        <div className="flex justify-center">
          Deployed, view workflows here:
        </div>

        <WorkflowList
          workflows={workflows}
          currentOrganizationSlug={currentOrganization.slug}
        />
      </>
    );
  }
}
