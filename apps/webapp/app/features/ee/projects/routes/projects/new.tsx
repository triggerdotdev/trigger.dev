import { InformationCircleIcon, StarIcon } from "@heroicons/react/20/solid";
import {
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudArrowUpIcon,
  LockClosedIcon,
  LockOpenIcon,
  MegaphoneIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  CloudIcon,
  RocketLaunchIcon,
  SunIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import {
  Await,
  Form,
  useFetcher,
  useLoaderData,
  useTransition,
} from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { defer } from "@remix-run/server-runtime";
import { Fragment, Suspense, useEffect, useState } from "react";
import { redirect, typedjson, useTypedActionData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { List } from "~/components/layout/List";
import { Panel } from "~/components/layout/Panel";
import { PanelWarning } from "~/components/layout/PanelWarning";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import {
  PrimaryButton,
  PrimaryLink,
  SecondaryButton,
  SecondaryLink,
  TertiaryLink,
} from "~/components/primitives/Buttons";
import { StyledDialog } from "~/components/primitives/Dialog";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { Header3, Header4 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { Tooltip } from "~/components/primitives/Tooltip";
import { NewProjectPresenter } from "~/features/ee/projects/presenters/newProjectPresenter.server";
import { CreateProjectService } from "~/features/ee/projects/services/createProject.server";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useUser } from "~/hooks/useUser";
import { requireUserId } from "~/services/session.server";

export async function loader({ request, params }: LoaderArgs) {
  const userId = await requireUserId(request);
  invariant(params.organizationSlug, "Organization slug is required");

  const presenter = new NewProjectPresenter();

  return defer(await presenter.data(userId, params.organizationSlug));
}

export async function action({ request, params }: LoaderArgs) {
  const userId = await requireUserId(request);
  invariant(params.organizationSlug, "Organization slug is required");

  const payload = Object.fromEntries(await request.formData());

  const service = new CreateProjectService();

  const validation = await service.validate(payload);

  switch (validation.type) {
    case "payloadError":
    case "serviceDefinitionError": {
      return typedjson(validation, { status: 422 });
    }
    case "success": {
      const result = await service.call(
        userId,
        params.organizationSlug,
        validation.data,
        validation.serviceDefinition,
        validation.repo,
        validation.latestCommit
      );

      if (result.type === "serviceError") {
        return typedjson(result, { status: 422 });
      }

      return redirect(
        `/orgs/${params.organizationSlug}/projects/${result.project.id}`
      );
    }
  }
}

export default function NewProjectPage() {
  const { appAuthorizations, redirectTo, repositories, canDeployMoreProjects } =
    useLoaderData<typeof loader>();

  const currentOrganization = useCurrentOrganization();

  if (currentOrganization === undefined) {
    return <></>;
  }

  const user = useUser();

  const actionData = useTypedActionData<typeof action>();
  const transition = useTransition();

  const isSubmittingOrLoading =
    (transition.state === "submitting" &&
      transition.type === "actionSubmission") ||
    (transition.state === "loading" &&
      transition.type === "actionRedirect" &&
      transition.submission.action.endsWith("/projects/new"));

  let [technologyPreviewIsOpen, setTechnologyPreviewIsOpen] = useState(false);

  const fetcher = useFetcher();

  useEffect(() => {
    if (fetcher.state === "submitting") {
      setTechnologyPreviewIsOpen(false);
    }
  }, [fetcher.state, setTechnologyPreviewIsOpen]);

  return (
    <>
      <StyledDialog.Dialog
        onClose={(e) => setTechnologyPreviewIsOpen(false)}
        appear
        show={technologyPreviewIsOpen}
        as={Fragment}
      >
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <StyledDialog.Panel className="mx-auto flex max-w-xl items-start gap-2 overflow-hidden">
              <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-slate-800 text-left">
                <div className="flex w-full items-center justify-between py-3 pr-3 pl-5">
                  <div className="flex w-full items-center gap-2">
                    <Header4 size="small" className="text-slate-300">
                      Multiple hosted repos is coming soon…
                    </Header4>
                  </div>
                  <button
                    onClick={(e) => setTechnologyPreviewIsOpen(false)}
                    className="group rounded p-1 text-slate-600 transition hover:bg-slate-700 hover:text-slate-500"
                  >
                    <XMarkIcon className="h-6 w-6 text-slate-600 transition group-hover:text-slate-400" />
                  </button>
                </div>
                <div className="relative flex flex-col items-center justify-between gap-5 overflow-hidden border-b border-slate-850/80 bg-blue-400 px-4 py-12">
                  <CloudIcon className="absolute top-2 -left-4 h-28 w-28 animate-pulse text-white" />
                  <CloudIcon className="absolute top-16 right-16 h-16 w-16 animate-pulse text-white" />
                  <SunIcon className="absolute -top-12 -right-12 h-32 w-32 text-yellow-400/70" />
                  <RocketLaunchIcon className="h-20 w-20 animate-[float_3s_ease-in-out_infinite] text-slate-800" />
                </div>
                <div className="p-6">
                  <Body size="regular" className="text-left text-slate-400">
                    Our full repo hosting service is coming soon, and we're
                    currently in a Technical Preview phase. While we put the
                    finishing touches on our service, you can deploy one repo at
                    a time. Don't worry, we'll be opening up this service to
                    multiple repos very soon. Be the first to know when we do by
                    clicking 'Notify Me' and stay in the loop.
                  </Body>
                  <div className="flex w-full justify-end">
                    {user.isOnHostedRepoWaitlist ? (
                      <PrimaryButton
                        onClick={() => setTechnologyPreviewIsOpen(false)}
                        className="mt-4 w-full"
                        disabled
                      >
                        <CheckIcon className="-ml-1 h-5 w-5" />
                        You'll be notified
                      </PrimaryButton>
                    ) : (
                      <fetcher.Form
                        action="/resources/cloud-waitlist"
                        method="post"
                      >
                        <PrimaryButton
                          onClick={() => setTechnologyPreviewIsOpen(false)}
                          className="mt-4 w-full"
                        >
                          <MegaphoneIcon className="-ml-1 h-5 w-5" />
                          Notify me
                        </PrimaryButton>
                      </fetcher.Form>
                    )}
                  </div>
                </div>
              </div>
            </StyledDialog.Panel>
          </div>
        </div>
      </StyledDialog.Dialog>
      <AppLayoutTwoCol>
        <OrganizationsSideMenu />
        <AppBody>
          <Header context="projects" />
          <Container>
            <div className="flex items-start justify-between">
              <Title>Repositories</Title>
              {appAuthorizations.length === 0 ? (
                <></>
              ) : (
                <>
                  <PrimaryLink
                    to={`/apps/github?redirectTo=${encodeURIComponent(
                      redirectTo
                    )}`}
                  >
                    <OctoKitty className="-ml-1 h-5 w-5" />
                    Connect another GitHub account
                  </PrimaryLink>
                </>
              )}
            </div>
            {appAuthorizations.length === 0 ? (
              <>
                <ConnectToGithub redirectTo={redirectTo} />
              </>
            ) : (
              <>
                {(!isSubmittingOrLoading &&
                  actionData?.type === "serviceDefinitionError") ||
                actionData?.type === "serviceError" ? (
                  <PanelWarning message={actionData.message} className="mb-4" />
                ) : !isSubmittingOrLoading &&
                  actionData?.type === "payloadError" ? (
                  <PanelWarning
                    message="Something went wrong with your request. Please try again."
                    className="mb-4"
                  />
                ) : (
                  <></>
                )}
                <Suspense
                  fallback={
                    <Panel className="mb-6 flex h-10 items-center justify-center gap-2 py-10">
                      <Spinner />
                      <Body>Loading repositories…</Body>
                    </Panel>
                  }
                >
                  <Await
                    errorElement={<p>Error loading repositories</p>}
                    resolve={repositories}
                  >
                    {(resolvedPromise) => (
                      <>
                        {resolvedPromise.map((reposWithAuth) => (
                          <Fragment key={reposWithAuth.authorization.id}>
                            <div className="flex w-full items-center justify-between">
                              <div className="mb-2 flex items-center gap-2">
                                <OctoKitty className="h-5 w-5" />
                                <SubTitle className="mb-0">
                                  {reposWithAuth.authorization.accountName}
                                </SubTitle>
                              </div>
                              <TertiaryLink
                                to={`/apps/github?redirectTo=${encodeURIComponent(
                                  redirectTo
                                )}&authorizationId=${
                                  reposWithAuth.authorization.id
                                }`}
                                reloadDocument
                              >
                                Configure{" "}
                                {reposWithAuth.authorization.accountName}
                                <ArrowTopRightOnSquareIcon className="h-4 w-4 text-slate-500" />
                              </TertiaryLink>
                            </div>
                            <List className="mb-6">
                              {reposWithAuth.repositories.map((repo) => (
                                <li
                                  key={repo.repository.id}
                                  className="flex items-center justify-between gap-2 py-2.5 pl-4 pr-2.5 first:rounded-t-md"
                                >
                                  <div className="flex items-center gap-2.5">
                                    {repo.repository.private ? (
                                      <LockClosedIcon className="h-4 w-4 text-slate-400" />
                                    ) : (
                                      <LockOpenIcon className="h-4 w-4 text-slate-400" />
                                    )}

                                    <a
                                      className="group flex items-center gap-2 text-slate-300 transition hover:text-slate-100"
                                      href={repo.repository.html_url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {repo.repository.full_name}#
                                      {repo.repository.default_branch}
                                      <ArrowTopRightOnSquareIcon className="h-4 w-4 text-slate-400 opacity-0 transition group-hover:opacity-100" />
                                    </a>
                                  </div>
                                  {repo.projectId ? (
                                    <div className="flex items-center gap-6">
                                      <SecondaryLink
                                        to={`../${repo.projectId}`}
                                      >
                                        View
                                        <ArrowRightIcon className="-mr-1 h-4 w-4 text-slate-300" />
                                      </SecondaryLink>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-6">
                                      {repo.status === "relevant" ? (
                                        <Tooltip text="This repo is configured for deploying a workflow">
                                          <div className="flex items-center gap-1 text-slate-400">
                                            <StarIcon className="h-4 w-4 text-yellow-500" />
                                            <Body size="small" className="">
                                              This repo contains a workflow
                                            </Body>
                                            <InformationCircleIcon className="h-4 w-4" />
                                          </div>
                                        </Tooltip>
                                      ) : (
                                        <></>
                                      )}
                                      {canDeployMoreProjects ? (
                                        <Form
                                          method="post"
                                          onSubmit={(e) =>
                                            !confirm(
                                              "This will deploy this repository and automatically run your workflows in the live environment. Are you sure?"
                                            ) && e.preventDefault()
                                          }
                                        >
                                          <input
                                            type="hidden"
                                            name="repoId"
                                            value={repo.repository.id}
                                          />

                                          <input
                                            type="hidden"
                                            name="repoName"
                                            value={repo.repository.full_name}
                                          />

                                          <input
                                            type="hidden"
                                            name="appAuthorizationId"
                                            value={repo.appAuthorizationId}
                                          />

                                          {isSubmittingOrLoading &&
                                          transition.submission.formData.get(
                                            "repoName"
                                          ) === repo.repository.full_name ? (
                                            <>
                                              <PrimaryButton
                                                type="submit"
                                                size="regular"
                                                disabled
                                              >
                                                <Spinner className="-ml-1 h-5 w-5" />
                                                Deploying
                                              </PrimaryButton>
                                            </>
                                          ) : (
                                            <PrimaryButton
                                              type="submit"
                                              size="regular"
                                              disabled={isSubmittingOrLoading}
                                            >
                                              <CloudArrowUpIcon className="-ml-1 h-5 w-5" />
                                              Deploy
                                            </PrimaryButton>
                                          )}
                                        </Form>
                                      ) : (
                                        <PrimaryButton
                                          size="regular"
                                          disabled={isSubmittingOrLoading}
                                          onClick={() =>
                                            setTechnologyPreviewIsOpen(true)
                                          }
                                        >
                                          <CloudArrowUpIcon className="-ml-1 h-5 w-5" />
                                          Deploy
                                        </PrimaryButton>
                                      )}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </List>
                          </Fragment>
                        ))}
                      </>
                    )}
                  </Await>
                </Suspense>
              </>
            )}
          </Container>
        </AppBody>
      </AppLayoutTwoCol>
    </>
  );
}

function ConnectToGithub({ redirectTo }: { redirectTo: string }) {
  return (
    <>
      <SubTitle className="flex items-center">
        Grant GitHub repo access to get started
      </SubTitle>
      <Panel className="mb-6 flex h-56 flex-col items-center justify-center gap-6">
        <PrimaryLink
          size="large"
          to={`/apps/github?redirectTo=${encodeURIComponent(redirectTo)}`}
        >
          <OctoKitty className="mr-1 h-5 w-5" />
          Grant access
        </PrimaryLink>
        <Body size="extra-small" className="flex items-center text-slate-400">
          To deploy a new project you need to authorize our GitHub app.{" "}
          <a
            href="https://docs.trigger.dev/faq#why-do-we-ask-for-github-access"
            target="_blank"
            rel="noreferrer"
            className="ml-1 underline decoration-slate-500 underline-offset-2 transition hover:cursor-pointer hover:text-slate-300"
          >
            Learn more.
          </a>
        </Body>
      </Panel>
    </>
  );
}
