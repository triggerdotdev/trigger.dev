import {
  CloudIcon,
  FolderIcon,
  HomeIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import { useRevalidator } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { Fragment, useEffect, useState } from "react";
import type { UseDataFunctionReturn } from "remix-typedjson";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { CopyTextButton } from "~/components/CopyTextButton";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import { PanelInfo } from "~/components/layout/PanelInfo";
import { StepNumber } from "~/components/onboarding/StepNumber";
import {
  PrimaryButton,
  TertiaryA,
  TertiaryLink,
} from "~/components/primitives/Buttons";
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
      <div className="grid grid-cols-3 gap-8">
        <div className="col-span-2">
          <Header1>You're almost done</Header1>
          {organizationTemplateByStatus}
        </div>
        <TemplateCard
          template={loaderData.template}
          className="sticky top-0 mt-12 max-w-[300px] justify-self-start"
        />
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
        <ConnectedToGithub />
        <div className="mb-2 ml-1 flex max-w-4xl items-center gap-4">
          <Spinner />
          <SubTitle className="mb-0">
            Cloning the template repo into your GitHub account...
          </SubTitle>
        </div>
        <ConfiguringGithubState
          githubAccount={
            loaderData.organizationTemplate.authorization.accountName
          }
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
      githubAccount={loaderData.organizationTemplate.authorization.accountName}
      isPrivate={loaderData.organizationTemplate.private}
      repositoryName={loaderData.repositoryName}
    />
  );

  return (
    <>
      {loaderData.organizationTemplate.status === "READY_TO_DEPLOY" ? (
        <>
          <ConnectedToGithub />
          {githubConfigured}
          <div className="mt-4 mb-2 flex max-w-4xl items-center justify-between">
            <div className="flex items-center">
              <StepNumber active stepNumber="3" />
              <SubTitle className="mb-0">
                Your template is ready to deploy
              </SubTitle>
            </div>
            <TertiaryA
              target="_blank"
              href={loaderData.organizationTemplate.repositoryUrl}
            >
              {loaderData.organizationTemplate.repositoryUrl.replace(
                "https://github.com/",
                ""
              )}
            </TertiaryA>
          </div>
          <Panel className="max-w-4xl !p-4">
            <DeploySection {...loaderData} />
          </Panel>
        </>
      ) : (
        <>
          <ConnectedToGithub />
          {githubConfigured}
          <div className="mt-4 mb-2 flex max-w-4xl items-center justify-between">
            <div className="flex items-center">
              <StepNumber active stepNumber="3" />
              <SubTitle className="mb-0">
                Your template has been deployed!
              </SubTitle>
            </div>
            <TertiaryA
              target="_blank"
              href={loaderData.organizationTemplate.repositoryUrl}
            >
              {loaderData.organizationTemplate.repositoryUrl.replace(
                "https://github.com/",
                ""
              )}
            </TertiaryA>
          </div>
          <Panel className="max-w-4xl">
            <DeploySection {...loaderData} />
          </Panel>
        </>
      )}
    </>
  );
}

function DeploySection({
  organizationTemplate,
  developmentApiKey,
  liveApiKey,
  workflows,
  runLocalDocsHTML,
}: {
  organizationTemplate: LoaderData["organizationTemplate"];
  developmentApiKey?: string;
  liveApiKey?: string;
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
                      Run your repository locally
                    </Header3>
                  </div>
                  <div className="flex rounded bg-slate-900/75 p-4">
                    <div
                      className="prose prose-invert [&>pre]:bg-[rgb(17,23,41)]"
                      dangerouslySetInnerHTML={{
                        __html: runLocalDocsHTML,
                      }}
                    />
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
        <div className="grid grid-cols-[minmax(0,_1fr)_4rem_minmax(0,_1fr)]">
          <div className="">
            <SubTitle className="flex items-center">Deploy locally</SubTitle>
            <Label className="text-sm text-slate-500">
              Development API key
            </Label>
            <div className="flex items-center justify-between rounded bg-black/20 py-2.5 px-3 text-slate-300">
              <span className="select-all text-slate-300">
                {developmentApiKey ?? "missing api key"}
              </span>
              <CopyTextButton
                variant="text"
                value={developmentApiKey ?? "missing api key"}
              />
            </div>
            <div className="mt-4 flex w-full justify-end">
              <PrimaryButton onClick={(e) => setIsOpen(true)}>
                <HomeIcon className="h-5 w-5 text-slate-200" />
                Run locally
              </PrimaryButton>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center gap-2">
            <div className="h-full border-l border-slate-700"></div>
            <Body size="small" className="uppercase text-slate-500">
              or
            </Body>
            <div className="h-full border-l border-slate-700"></div>
          </div>
          <div>
            <SubTitle className="flex items-center">
              Deploy to
              <a
                href="https://render.com"
                target="_blank"
                rel="noreferrer"
                className="ml-1.5 underline transition hover:text-white"
              >
                Render
              </a>
            </SubTitle>
            <Label className="text-sm text-slate-500">Live API key</Label>
            <div className="flex items-center justify-between rounded bg-black/20 py-2.5 px-3 text-slate-300">
              <span className="select-all text-slate-300">
                {liveApiKey ?? "missing api key"}
              </span>
              <CopyTextButton
                variant="text"
                value={liveApiKey ?? "missing api key"}
              />
            </div>
            <div className="mt-4 flex w-full items-center justify-end">
              <a
                href={`https://render.com/deploy?repo=${organizationTemplate.repositoryUrl}`}
                target="_blank"
                rel="noreferrer"
                className="transition hover:opacity-80"
              >
                <img
                  src="https://render.com/images/deploy-to-render-button.svg"
                  alt="Deploy to Render"
                  className="h-[36px]"
                />
              </a>
            </div>
          </div>
        </div>
      </>
    );
  } else {
    return (
      <div className="max-w-4xl">
        <div className="relative rounded-lg bg-slate-850 p-4">
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
      <div className="absolute top-0 left-0 flex h-full w-full items-center justify-center bg-slate-850/70">
        <PanelInfo message="This can take up to 30 seconds" className="w-max" />
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

// Skeleton and completed states
export function ConnectedToGithub({ templateId }: { templateId?: string }) {
  return (
    <div className="mt-6 flex max-w-4xl items-center justify-between">
      <SubTitle className="flex items-center">
        <StepNumber complete />
        GitHub connected
      </SubTitle>
      <TertiaryLink
        to={`../apps/github${templateId ? `?templateId=${templateId}` : ""}`}
      >
        Add another connection
      </TertiaryLink>
    </div>
  );
}

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
    <>
      <SubTitle className="flex items-center">
        <StepNumber complete />
        GitHub repository created
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
    </>
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
