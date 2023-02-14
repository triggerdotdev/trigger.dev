import {
  ArrowSmallRightIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentCheckIcon,
  ClockIcon,
} from "@heroicons/react/24/outline";
import {
  CheckCircleIcon,
  FolderIcon,
  CloudIcon,
} from "@heroicons/react/24/solid";
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
import { PrimaryButton } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Select } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header3,
} from "~/components/primitives/text/Headers";
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
      <Header1>You're almost done</Header1>
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
      <>
        <div className="mt-4 mb-2 flex max-w-4xl items-center gap-2">
          <Spinner />
          <SubTitle className="mb-0">
            Setting up the template in your new repo…
          </SubTitle>
        </div>
        <ConfiguringGithubState />
        <TempBlankState />
      </>
    );
  }

  return <OrganizationTemplateReady {...loaderData} />;
}

function OrganizationTemplateReady(loaderData: LoaderData) {
  return (
    <div>
      {loaderData.organizationTemplate.status === "READY_TO_DEPLOY" ? (
        <>
          <GitHubConfigured />
          <div className="mt-4 mb-0.5 flex items-center gap-2">
            <Spinner />
            <SubTitle className="mb-0">
              {loaderData.organizationTemplate.template.title} template ready
              and waiting to deploy
            </SubTitle>
          </div>
          <Panel className="max-w-4xl p-4">
            <TemplateHeader
              organizationTemplate={loaderData.organizationTemplate}
            />
            <DeploySection {...loaderData} />
          </Panel>
        </>
      ) : (
        <>
          <div className="mt-4 mb-1 flex items-center gap-1">
            <CheckCircleIcon className="h-6 w-6 text-green-400" />
            <SubTitle className="mb-0">Template deployed to Render</SubTitle>
          </div>
          <Panel className="max-w-4xl">
            <TemplateHeader
              organizationTemplate={loaderData.organizationTemplate}
            />
            <DeploySection {...loaderData} />
          </Panel>
        </>
      )}
    </div>
  );
}

function TemplateHeader({
  organizationTemplate,
}: {
  organizationTemplate: LoaderData["organizationTemplate"];
}) {
  return (
    <>
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
    </>
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
      </>
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

function ConfiguringGithubState() {
  return (
    <Panel className="pointer-events-none relative max-w-4xl overflow-hidden !p-4">
      <div className="absolute top-0 left-0 flex h-full w-full flex-col items-center justify-center gap-4 bg-slate-850/50">
        <ClockIcon className="h-10 w-10 animate-pulse text-slate-500" />
        <Body>This can take up to 1 minute</Body>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-4">
        <InputGroup>
          <Label htmlFor="appAuthorizationId">Select a GitHub account</Label>
          <Select name="appAuthorizationId" required></Select>
        </InputGroup>
        <InputGroup>
          <Label htmlFor="templateId">Choose a template</Label>

          <Select name="templateId" required></Select>
        </InputGroup>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-4">
        <InputGroup>
          <Label htmlFor="name">Choose a name</Label>
          <Input id="name" name="name" spellCheck={false} />
        </InputGroup>
        <div>
          <p className="mb-1 text-sm text-slate-500">Set the repo as private</p>
          <div className="flex w-full items-center rounded bg-black/20 px-3 py-2.5">
            <Label
              htmlFor="private"
              className="flex h-5 cursor-pointer items-center gap-2 text-sm text-slate-300"
            ></Label>
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <PrimaryButton disabled type="submit">
          Adding Template…
        </PrimaryButton>
      </div>
    </Panel>
  );
}

// Skeleton states

function GitHubConfigured() {
  return (
    <div className="mb-6">
      <div className="mt-4 mb-1 flex items-center gap-1">
        <CheckCircleIcon className="h-6 w-6 text-green-400" />
        <SubTitle className="mb-0">GitHub configured</SubTitle>
      </div>
      <Panel className="pointer-events-none relative max-w-4xl overflow-hidden !p-4">
        <div className="absolute top-0 left-0 flex h-full w-full flex-col items-center justify-center gap-4 bg-slate-850/40"></div>
        <div className="mb-3 grid grid-cols-2 gap-4">
          <InputGroup>
            <Label htmlFor="appAuthorizationId">Select a GitHub account</Label>
            <Select name="appAuthorizationId" required></Select>
          </InputGroup>
          <InputGroup>
            <Label htmlFor="templateId">Choose a template</Label>

            <Select name="templateId" required></Select>
          </InputGroup>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-4">
          <InputGroup>
            <Label htmlFor="name">Choose a name</Label>
            <Input id="name" name="name" spellCheck={false} />
          </InputGroup>
          <div>
            <p className="mb-1 text-sm text-slate-500">
              Set the repo as private
            </p>
            <div className="flex w-full items-center rounded bg-black/20 px-3 py-2.5">
              <Label
                htmlFor="private"
                className="flex h-5 cursor-pointer items-center gap-2 text-sm text-slate-300"
              ></Label>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function TempBlankState() {
  return (
    <div className="mt-6">
      <SubTitle className="text-slate-600">Deploy</SubTitle>
      <Panel className="flex h-80 w-full max-w-4xl items-center justify-center gap-6 ">
        <FolderIcon className="h-10 w-10 text-slate-600" />
        <div className="h-[1px] w-16 border border-dashed border-slate-600"></div>
        <CloudIcon className="h-10 w-10 text-slate-600" />
      </Panel>
    </div>
  );
}
