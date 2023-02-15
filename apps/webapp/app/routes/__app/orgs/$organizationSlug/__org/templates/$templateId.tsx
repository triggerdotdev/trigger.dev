import {
  ArrowTopRightOnSquareIcon,
  ClockIcon,
} from "@heroicons/react/24/outline";
import {
  CheckCircleIcon,
  CloudIcon,
  FolderIcon,
  HomeIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import { useRevalidator } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { Fragment, useEffect, useState } from "react";
import {
  typedjson,
  UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { CopyTextButton } from "~/components/CopyTextButton";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import { StepNumber } from "~/components/onboarding/StepNumber";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { StyledDialog } from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Select } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { TemplateCard } from "~/components/templates/TemplateCard";
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
      <div className="grid grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)_minmax(0,_1fr)_300px] gap-4">
        <div className="col-span-3">
          <Header1>You're almost done</Header1>
          {organizationTemplateByStatus}
        </div>
        <TemplateCard template={loaderData.template} />
      </div>
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
        <div>
          <TemplateCard template={loaderData.template} />
        </div>
        <ConnectedToGithub accountName={loaderData.githubAccount.login} />
        <div className="mt-4 mb-2 flex max-w-4xl items-center gap-2">
          <Spinner />
          <SubTitle className="mb-0">
            Cloning the template repo into your GitHub account...
          </SubTitle>
        </div>
        <ConfiguringGithubState
          githubAccount={loaderData.githubAccount.login}
          isPrivate={loaderData.organizationTemplate.private}
          repositoryName={loaderData.repositoryName}
        />
        <DeployBlankState />
      </>
    );
  }

  return <OrganizationTemplateReady {...loaderData} />;
}

function OrganizationTemplateReady(loaderData: LoaderData) {
  const githubConfigured = (
    <GitHubConfigured
      githubAccount={loaderData.githubAccount.login}
      isPrivate={loaderData.organizationTemplate.private}
      repositoryName={loaderData.repositoryName}
    />
  );

  return (
    <>
      {loaderData.organizationTemplate.status === "READY_TO_DEPLOY" ? (
        <>
          <ConnectedToGithub accountName={loaderData.githubAccount.login} />
          {githubConfigured}
          <div className="mt-4 mb-1 flex items-center gap-2">
            <Spinner />
            <SubTitle className="mb-0">
              {loaderData.organizationTemplate.template.title} template is ready
              and waiting to deploy
            </SubTitle>
          </div>
          <Panel className="max-w-4xl !p-4">
            <TemplateHeader
              organizationTemplate={loaderData.organizationTemplate}
            />
            <DeploySection {...loaderData} />
          </Panel>
        </>
      ) : (
        <>
          <ConnectedToGithub accountName={loaderData.githubAccount.login} />
          {githubConfigured}
          <div className="mt-4 flex items-center gap-1">
            <SubTitle className="flex items-center">
              <StepNumber complete />
              Template deployed
            </SubTitle>
          </div>
          <Panel className="max-w-4xl">
            <TemplateHeader
              organizationTemplate={loaderData.organizationTemplate}
            />
            <DeploySection {...loaderData} />
          </Panel>
        </>
      )}
    </>
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
          <div className="flex items-center justify-between rounded bg-black/20 py-2 pl-3 pr-2">
            <span className="select-all">
              {organizationTemplate.repositoryUrl}
            </span>
            <a
              href={organizationTemplate.repositoryUrl}
              target="_blank"
              className="group"
            >
              <ArrowTopRightOnSquareIcon className="h-[18px] w-[18px] text-slate-300 transition group-hover:text-white" />
            </a>
          </div>
        </div>
        <div>
          <Label className="text-sm text-slate-500">Type</Label>
          <div className="flex items-center rounded bg-black/20 py-2 px-3 text-slate-500">
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
  runLocalDocsHTML,
}: {
  organizationTemplate: LoaderData["organizationTemplate"];
  apiKey: string;
  workflows: LoaderData["workflows"];
  runLocalDocsHTML: LoaderData["runLocalDocsHTML"];
}) {
  const currentOrganization = useCurrentOrganization();
  let [isOpen, setIsOpen] = useState(false);

  if (!currentOrganization) {
    return null;
  }

  if (organizationTemplate.status === "READY_TO_DEPLOY") {
    return (
      <>
        <StyledDialog.Dialog
          onClose={(e) => setIsOpen(false)}
          appear
          show={isOpen}
          as={Fragment}
        >
          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4">
              <StyledDialog.Panel className="mx-auto flex max-w-3xl items-start gap-2 overflow-hidden">
                <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-slate-800 text-left">
                  <div className="relative flex flex-col items-center justify-between gap-5 overflow-hidden border-b border-slate-850/80 bg-blue-400 px-4 py-12">
                    <CloudIcon className="absolute top-2 -left-4 h-28 w-28 text-white/50" />
                    <HomeIcon className="absolute bottom-0 right-[calc(50%-2rem)] h-16 w-16 text-stone-900" />
                    <CloudIcon className="absolute top-4 right-6 h-16 w-16 text-white/50" />
                    <div className="absolute -bottom-[150px] h-40 w-[20rem] rounded-full bg-green-700"></div>
                    <Header3 className="mb-6 font-semibold">
                      Run your workflow locally
                    </Header3>
                  </div>
                  <div className="p-6">
                    <div className="flex h-full w-full flex-col gap-y-1 rounded ">
                      <div className="flex rounded bg-slate-900/75 p-4">
                        <p
                          className="prose prose-sm prose-invert"
                          dangerouslySetInnerHTML={{
                            __html: runLocalDocsHTML,
                          }}
                        />
                      </div>
                    </div>
                    <PrimaryButton
                      onClick={() => setIsOpen(false)}
                      className="mt-6 w-full"
                    >
                      Close
                    </PrimaryButton>
                  </div>
                </div>
                <button
                  onClick={() => setIsOpen(false)}
                  className="sticky top-0 text-slate-600 transition hover:text-slate-500"
                >
                  <XCircleIcon className="h-10 w-10" />
                </button>
              </StyledDialog.Panel>
            </div>
          </div>
        </StyledDialog.Dialog>
        <div className="mt-2">
          <Label className="text-sm text-slate-500">API key</Label>
          <div className="flex items-center justify-between rounded bg-black/20 py-2.5 px-3 text-slate-300">
            <span className="select-all">{apiKey}</span>
            <CopyTextButton variant="text" value={apiKey} />
          </div>
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <PrimaryButton onClick={(e) => setIsOpen(true)}>
            <HomeIcon className="h-5 w-5 text-slate-200" />
            Run locally
          </PrimaryButton>
          <Body size="small" className="uppercase text-slate-500">
            or
          </Body>
          <a
            href={`https://render.com/deploy?repo=${organizationTemplate.repositoryUrl}`}
            target="_blank"
            className="transition hover:opacity-80"
          >
            <img
              src="https://render.com/images/deploy-to-render-button.svg"
              alt="Deploy to Render"
              className="h-[36px]"
            />
          </a>
        </div>
      </>
    );
  } else {
    return (
      <div className="mt-4 max-w-4xl">
        <Label className="mb-3 text-sm text-slate-500">
          View your new workflow:
        </Label>
        <div className="relative mt-1 rounded-lg bg-slate-850 p-4">
          <div className="absolute inset-2.5 z-0 h-[calc(100%-20px)] w-[calc(100%-20px)] animate-pulse rounded-md bg-gradient-to-r from-indigo-500 to-pink-500 blur-sm"></div>
          <WorkflowList
            className="relative z-50 !mb-0"
            workflows={workflows}
            currentOrganizationSlug={currentOrganization.slug}
          />
        </div>
      </div>
    );
  }
}

function ConfiguringGithubState({
  githubAccount,
  isPrivate,
  repositoryName,
}: {
  githubAccount: string;
  isPrivate: boolean;
  repositoryName: string;
}) {
  return (
    <Panel className="pointer-events-none relative max-w-4xl overflow-hidden !p-4">
      <div className="absolute top-0 left-0 flex h-full w-full flex-col items-center justify-center gap-4 bg-slate-850/50">
        <ClockIcon className="h-10 w-10 animate-pulse text-indigo-500" />
        <Body>This can take up to 30 seconds</Body>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-4">
        <InputGroup>
          <Label htmlFor="appAuthorizationId">Select a GitHub account</Label>
          <Select name="appAuthorizationId" required>
            <option>{githubAccount}</option>
          </Select>
        </InputGroup>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-4">
        <InputGroup>
          <Label htmlFor="name">Choose a name</Label>
          <Input
            id="name"
            name="name"
            spellCheck={false}
            value={repositoryName}
            disabled
          />
        </InputGroup>
        <div>
          <p className="mb-1 text-sm text-slate-500">Set the repo as private</p>
          <div className="flex w-full items-center rounded bg-black/20 px-3 py-2.5">
            <Label
              htmlFor="private"
              className="flex h-5 cursor-pointer items-center gap-2 text-sm text-slate-300"
            >
              <input
                type="checkbox"
                name="private"
                id="private"
                className="border-3 h-4 w-4 cursor-pointer rounded border-black bg-slate-200 transition hover:bg-slate-300 focus:outline-none"
                checked={isPrivate}
                disabled
              />
              Private repo
            </Label>
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
function ConnectedToGithub({ accountName }: { accountName: string }) {
  return (
    <div className="mt-6">
      <SubTitle className="flex items-center">
        <StepNumber complete />
        GitHub connected
      </SubTitle>
      <Panel className="relative mb-6 flex w-full max-w-4xl items-center gap-2 !p-4">
        <OctoKitty className="h-5 w-5 opacity-40" />
        <a
          href={`https://github.com/${accountName}`}
          target="_blank"
          className="font-sm text-slate-400 transition hover:text-white"
        >
          https://github.com/{accountName}
        </a>
      </Panel>
    </div>
  );
}

// Skeleton states
function GitHubConfigured({
  githubAccount,
  isPrivate,
  repositoryName,
}: {
  githubAccount: string;
  isPrivate: boolean;
  repositoryName: string;
}) {
  return (
    <div className="mb-6">
      <SubTitle className="mt-4 flex items-center">
        <StepNumber complete />
        GitHub configured
      </SubTitle>
      <Panel className="pointer-events-none relative max-w-4xl overflow-hidden !p-4">
        <div className="absolute top-0 left-0 flex h-full w-full flex-col items-center justify-center gap-4 bg-slate-850/40"></div>
        <div className="mb-3 grid grid-cols-2 gap-4">
          <InputGroup>
            <Label htmlFor="appAuthorizationId">GitHub account</Label>
            <Select name="appAuthorizationId" required>
              <option>{githubAccount}</option>
            </Select>
          </InputGroup>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-4">
          <InputGroup>
            <Label htmlFor="name">Repo name</Label>
            <Input
              id="name"
              name="name"
              spellCheck={false}
              value={repositoryName}
              disabled
            />
          </InputGroup>
          <div>
            <p className="mb-1 text-sm text-slate-500">Repo</p>
            <div className="flex w-full items-center rounded bg-black/20 px-3 py-2.5">
              <Label
                htmlFor="private"
                className="flex h-5 cursor-pointer items-center gap-2 text-sm text-slate-300"
              >
                <input
                  type="checkbox"
                  name="private"
                  id="private"
                  className="border-3 h-4 w-4 cursor-pointer rounded border-black bg-slate-200 transition hover:bg-slate-300 focus:outline-none"
                  checked={isPrivate}
                  disabled
                />
                Private repo
              </Label>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

export function DeployBlankState() {
  return (
    <div className="mt-6">
      <SubTitle className="flex items-center">
        <StepNumber stepNumber="3" />
        Deploy
      </SubTitle>
      <Panel className="flex h-56 w-full max-w-4xl items-center justify-center gap-6">
        <FolderIcon className="h-10 w-10 text-slate-600" />
        <div className="h-[1px] w-16 border border-dashed border-slate-600"></div>
        <CloudIcon className="h-10 w-10 text-slate-600" />
      </Panel>
    </div>
  );
}
