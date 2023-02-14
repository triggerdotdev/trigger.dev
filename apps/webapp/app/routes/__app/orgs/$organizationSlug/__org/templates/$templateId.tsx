import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentCheckIcon,
} from "@heroicons/react/24/outline";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
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
import { CopyTextButton } from "~/components/CopyTextButton";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import { Label } from "~/components/primitives/Label";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { Header1 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
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
      <Panel className="mt-4 flex max-w-4xl items-center gap-2 py-4 pl-4">
        <Spinner />
        <Body>Setting up the template in your new repo…</Body>
      </Panel>
    );
  }

  return <OrganizationTemplateReady {...loaderData} />;
}

function OrganizationTemplateReady(loaderData: LoaderData) {
  return (
    <div>
      {loaderData.organizationTemplate.status === "READY_TO_DEPLOY" ? (
        <div className="mt-4 mb-0.5 flex items-center gap-2">
          <Spinner />
          <SubTitle className="mb-0">
            Template ready and waiting to deploy
          </SubTitle>
        </div>
      ) : (
        <div className="mt-4 mb-1 flex items-center gap-1">
          <CheckCircleIcon className="h-6 w-6 text-green-400" />
          <SubTitle className="mb-0">Template deployed to Render</SubTitle>
        </div>
      )}
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
    <Panel className="max-w-4xl">
      <div className="grid grid-cols-4 gap-4">
        <div className="col-span-3">
          <Label className="text-sm text-slate-500">Repo URL</Label>
          <div className="flex items-center justify-between rounded bg-slate-850 py-2 pl-3 pr-2">
            <span className="select-all">
              {organizationTemplate.repositoryUrl}
            </span>
            <a
              href={organizationTemplate.repositoryUrl}
              target="_blank"
              className="group"
            >
              <ArrowTopRightOnSquareIcon className="h-[18px] w-[18px] text-slate-200 transition group-hover:text-green-500" />
            </a>
          </div>
        </div>
        <div>
          <Label className="text-sm text-slate-500">Type</Label>
          <div className="flex items-center rounded bg-slate-850 py-2 px-3 text-slate-500">
            {organizationTemplate.private ? "Private repo" : "Public repo"}
          </div>
        </div>
      </div>
    </Panel>
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
      <Panel className="max-w-4xl">
        <div className="grid grid-cols-1">
          <div className="mt-2">
            <Label className="text-sm text-slate-500">API key</Label>
            <div className="flex items-center justify-between rounded bg-slate-850 py-1 pl-3 pr-1 text-slate-300">
              <span className="select-all">{apiKey}</span>
              <CopyTextButton value={apiKey} />
            </div>
          </div>
          <a
            href={`https://render.com/deploy?repo=${organizationTemplate.repositoryUrl}`}
            target="_blank"
            className="mt-6 place-self-end"
          >
            <img
              src="https://render.com/images/deploy-to-render-button.svg"
              alt="Deploy to Render"
              className="h-10"
            />
          </a>
        </div>
      </Panel>
    );
  } else {
    return (
      <div className="mt-6 max-w-4xl">
        <div className="mb-1 flex items-center gap-1">
          <CheckCircleIcon className="h-6 w-6 text-green-400" />
          <SubTitle className="mb-0">Workflow successfully created</SubTitle>
        </div>

        <WorkflowList
          workflows={workflows}
          currentOrganizationSlug={currentOrganization.slug}
        />
      </div>
    );
  }
}
