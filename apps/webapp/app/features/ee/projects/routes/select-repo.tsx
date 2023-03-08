import { FolderIcon } from "@heroicons/react/20/solid";
import {
  ArrowTopRightOnSquareIcon,
  LockClosedIcon,
  LockOpenIcon,
} from "@heroicons/react/24/outline";
import { Await, Form, useLoaderData, useTransition } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { defer } from "@remix-run/server-runtime";
import classNames from "classnames";
import { Suspense } from "react";
import { redirect, typedjson, useTypedActionData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { Container } from "~/components/layout/Container";
import { List } from "~/components/layout/List";
import { Panel } from "~/components/layout/Panel";
import { PanelWarning } from "~/components/layout/PanelWarning";
import { StepNumber } from "~/components/onboarding/StepNumber";
import {
  PrimaryButton,
  PrimaryLink,
  SecondaryLink,
  TertiaryLink,
} from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { NewProjectPresenter } from "~/features/ee/projects/presenters/newProjectPresenter.server";
import { CreateProjectService } from "~/features/ee/projects/services/createProject.server";
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
        validation.serviceDefinition
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

export default function Page() {
  const { appAuthorizations, redirectTo, repositories } =
    useLoaderData<typeof loader>();

  const actionData = useTypedActionData<typeof action>();
  const transition = useTransition();

  const isSubmittingOrLoading =
    (transition.state === "submitting" &&
      transition.type === "actionSubmission") ||
    (transition.state === "loading" && transition.type === "actionRedirect");

  return (
    <Container>
      <Title>Deploy a GitHub repository</Title>
      <Form method="post" className="w-full">
        {appAuthorizations.length === 0 ? (
          <>
            <ConnectToGithub redirectTo={redirectTo} />
            <ConfigureGithub />
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
            <div className="flex w-full items-center justify-between">
              <div className="mb-2 flex items-center gap-2">
                <OctoKitty className="h-5 w-5" />
                <SubTitle className="mb-0">samejr</SubTitle>
              </div>
              <TertiaryLink to={`#`} reloadDocument>
                Configure samejr
                <ArrowTopRightOnSquareIcon className="h-4 w-4 text-slate-500" />
              </TertiaryLink>
            </div>
            <List className="mb-6 pl-4 pr-2.5">
              <Suspense
                fallback={
                  <div className="flex h-10 items-center justify-center gap-2 py-10">
                    <Spinner />
                    <Body>Loading repositories…</Body>
                  </div>
                }
              >
                <Await
                  errorElement={<p>Error loading repositories</p>}
                  resolve={repositories}
                >
                  {(repos) => (
                    <>
                      {repos.map((repo) => (
                        <li
                          key={repo.repository.id}
                          className={classNames(
                            "flex items-center justify-between gap-2 py-2.5",
                            repo.status === "relevant"
                              ? "bg-blue-500 text-white"
                              : "text-slate-400"
                          )}
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
                            <SecondaryLink to={`../projects/${repo.projectId}`}>
                              View Project
                            </SecondaryLink>
                          ) : (
                            <Form method="post">
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

                              <PrimaryButton type="submit" size="regular">
                                Select
                              </PrimaryButton>
                            </Form>
                          )}
                        </li>
                      ))}
                    </>
                  )}
                </Await>
              </Suspense>
            </List>
            <div className="flex w-full items-center justify-between">
              <div className="mb-2 flex items-center gap-2">
                <OctoKitty className="h-5 w-5" />
                <SubTitle className="mb-0">triggerdotdev</SubTitle>
              </div>
              <TertiaryLink to={`#`} reloadDocument>
                Configure triggerdotdev
                <ArrowTopRightOnSquareIcon className="h-4 w-4 text-slate-500" />
              </TertiaryLink>
            </div>
            <List className="pl-4 pr-2.5">
              <Suspense
                fallback={
                  <div className="flex h-10 items-center justify-center gap-2 py-10">
                    <Spinner />
                    <Body>Loading repositories…</Body>
                  </div>
                }
              >
                <Await
                  errorElement={<p>Error loading repositories</p>}
                  resolve={repositories}
                >
                  {(repos) => (
                    <>
                      {repos.map((repo) => (
                        <li
                          key={repo.repository.id}
                          className={classNames(
                            "flex items-center justify-between gap-2 py-2.5",
                            repo.status === "relevant"
                              ? "bg-blue-500 text-white"
                              : "text-slate-400"
                          )}
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
                            <SecondaryLink to={`../projects/${repo.projectId}`}>
                              View Project
                            </SecondaryLink>
                          ) : (
                            <Form method="post">
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

                              <PrimaryButton type="submit" size="regular">
                                Select
                              </PrimaryButton>
                            </Form>
                          )}
                        </li>
                      ))}
                    </>
                  )}
                </Await>
              </Suspense>
            </List>
            <SubTitle>Connect another GitHub account</SubTitle>
            <div className="mb-3 grid grid-cols-2 gap-4">
              <PrimaryLink
                to={`/apps/github?redirectTo=${encodeURIComponent(redirectTo)}`}
              >
                <OctoKitty className="-ml-1 h-5 w-5" />
                Add another account
              </PrimaryLink>
            </div>
          </>
        )}
      </Form>
    </Container>
  );
}

function ConnectToGithub({ redirectTo }: { redirectTo: string }) {
  return (
    <>
      <SubTitle className="flex items-center">
        <StepNumber active stepNumber="1" />
        Grant GitHub repo access to get started
      </SubTitle>
      <Panel className="mb-6 flex h-56 flex-col items-center justify-center gap-4">
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

function ConfigureGithub() {
  return (
    <>
      <div className="mt-6">
        <SubTitle className="flex items-center">
          <StepNumber stepNumber="2" />
          Create your GitHub repository from a template
        </SubTitle>
        <Panel className="flex w-full items-center justify-center gap-6">
          <OctoKitty className="h-10 w-10 text-slate-600" />
          <div className="h-[1px] w-16 border border-dashed border-slate-600"></div>
          <FolderIcon className="h-10 w-10 text-slate-600" />
        </Panel>
      </div>
    </>
  );
}
