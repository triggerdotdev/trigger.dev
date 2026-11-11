import { parseWithZod } from "@conform-to/zod/v4";
import { useLocation } from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentIcon } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import {
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { isTrustedDeploysEnabled } from "~/services/trustedDeploys/featureFlag.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  deleteTrustedDeployRepository,
  deleteTrustedDeployEnvironment,
  getTrustedDeploySettings,
  saveTrustedDeployEnvironment,
  saveTrustedDeployRepository,
  TrustedDeploySettingsError,
} from "~/services/trustedDeploys/settings.server";
import { cn } from "~/utils/cn";
import { pageMeta } from "~/utils/pageTitle";
import { docsPath, EnvironmentParamSchema, v3TrustedPublishingPath } from "~/utils/pathBuilder";
import { EnvironmentForm, RepositoryForm } from "./forms";
import { publishingPolicyFromForm, EnvironmentFormSchema, RepositoryFormSchema } from "./schemas";

export const meta = pageMeta("Trusted publishing");

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
  },
  async ({ params, user, ability }) => {
    const project = await findProjectWithOrgFlagsBySlug(
      params.organizationSlug,
      params.projectParam,
      user.id
    );
    if (!project) throw new Response("Project not found", { status: 404 });
    if (!(await isTrustedDeploysEnabled(project.organization.featureFlags))) {
      throw new Response("Not found", { status: 404 });
    }
    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) throw new Response("Environment not found", { status: 404 });

    return typedjson({
      environmentType: environment.type,
      canManage: ability.can("manage", { type: "project" }),
      settings:
        environment.type === "DEVELOPMENT"
          ? null
          : await getTrustedDeploySettings(
              project.id,
              environment.parentEnvironmentId ?? environment.id
            ),
    });
  }
);

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "manage", resource: { type: "project" } },
  },
  async ({ params, user, request }) => {
    const project = await findProjectWithOrgFlagsBySlug(
      params.organizationSlug,
      params.projectParam,
      user.id,
      prisma
    );
    if (!project) throw new Response("Project not found", { status: 404 });
    if (!(await isTrustedDeploysEnabled(project.organization.featureFlags))) {
      throw new Response("Not found", { status: 404 });
    }
    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id, prisma);
    if (!environment || environment.type === "DEVELOPMENT") {
      throw new Response("Publishing requires a deployed environment.", {
        status: 400,
      });
    }

    const formData = await request.formData();
    const path = v3TrustedPublishingPath(
      { slug: params.organizationSlug },
      { slug: params.projectParam },
      { slug: params.envParam }
    );
    if (formData.get("intent") === "delete-repository") {
      await deleteTrustedDeployRepository(project.id);
      return redirectWithSuccessMessage(path, request, "Trusted repository deleted");
    }
    if (formData.get("intent") === "repository") {
      const submission = parseWithZod(formData, {
        schema: RepositoryFormSchema,
      });
      if (submission.status !== "success") {
        return json({ formId: "repository", result: submission.reply() });
      }
      const { identityChanged } = await saveTrustedDeployRepository(project.id, submission.value);
      return redirectWithSuccessMessage(
        path,
        request,
        identityChanged
          ? "Repository updated. Existing environment grants were disabled."
          : "Trusted repository saved"
      );
    }
    const runtimeEnvironmentId = environment.parentEnvironmentId ?? environment.id;
    if (formData.get("intent") === "delete-environment") {
      await deleteTrustedDeployEnvironment(project.id, runtimeEnvironmentId);
      return redirectWithSuccessMessage(path, request, "Publishing settings deleted");
    }
    const submission = parseWithZod(formData, {
      schema: EnvironmentFormSchema,
    });
    const formId = `environment-${runtimeEnvironmentId}`;
    if (submission.status !== "success") {
      return json({ formId, result: submission.reply() });
    }
    try {
      await saveTrustedDeployEnvironment(project.id, {
        repositoryUpdatedAt: submission.value.repositoryUpdatedAt,
        runtimeEnvironmentId,
        type: environment.type,
        ...publishingPolicyFromForm(submission.value),
      });
    } catch (error) {
      if (!(error instanceof TrustedDeploySettingsError)) throw error;
      return json(
        { formId, result: submission.reply({ formErrors: [error.message] }) },
        { status: 400 }
      );
    }
    return redirectWithSuccessMessage(path, request, "Publishing settings saved");
  }
);

const environmentNames = {
  DEVELOPMENT: "Development",
  STAGING: "Staging",
  PREVIEW: "Preview",
  PRODUCTION: "Production",
} as const;

export default function TrustedPublishingPage() {
  const { pathname } = useLocation();
  const { settings, environmentType, canManage } = useTypedLoaderData<typeof loader>();
  const environment = settings?.environment;
  const grant = environment?.trustedDeployGrant;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Trusted publishing" />
        <PageAccessories>
          <LinkButton
            to={docsPath("deployment/trusted-publishing")}
            variant="secondary/small"
            target="_blank"
          >
            Documentation
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <SettingsContainer className="mb-12 md:mt-6">
          {settings ? (
            <>
              <SettingsSection>
                <Callout variant="info" className="mb-6">
                  Use Trigger CLI version 4.8.4 or later.
                </Callout>
                {!canManage && (
                  <Callout variant="info" className="mb-6">
                    You can view these settings, but need project manage permission to edit them.
                  </Callout>
                )}
                <SettingsHeader
                  title="GitHub repository"
                  description="Workflows in this repository can deploy without a Trigger.dev API key. Shared by every environment in this project."
                />
                <RepositoryForm
                  key={`${pathname}-${settings.repository?.updatedAt.toISOString() ?? "new"}`}
                  repository={settings.repository}
                  canManage={canManage}
                />
              </SettingsSection>
              <SettingsSection className={!settings.repository ? "opacity-50" : undefined}>
                <SettingsHeader
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      <EnvironmentIcon environment={{ type: environmentType }} className="size-5" />
                      {environmentNames[environmentType]}
                    </span>
                  }
                  description={
                    environmentType === "PREVIEW" ? (
                      <>
                        Applies to every Preview branch.{" "}
                        <InlineCode variant="extra-small">pull_request</InlineCode> workflows are
                        allowed; add claims to restrict them.
                      </>
                    ) : (
                      `Choose which workflows can deploy to ${environmentNames[environmentType]}.`
                    )
                  }
                  action={environment ? <PublishingStatus grant={grant} /> : undefined}
                />
                {environment ? (
                  <EnvironmentForm
                    key={`${pathname}-${environment.id}-${settings.repository?.updatedAt.toISOString() ?? "new"}-${grant?.updatedAt.toISOString() ?? "new"}`}
                    environment={{ id: environment.id, grant }}
                    environmentType={environmentType}
                    canManage={canManage}
                    repositoryUpdatedAt={settings.repository?.updatedAt.toISOString() ?? ""}
                  />
                ) : (
                  <SettingsRow description="Enable this environment before configuring trusted publishing." />
                )}
              </SettingsSection>
            </>
          ) : (
            <Callout variant="info">
              Trusted publishing is not available for local development. Choose Staging, Preview, or
              Production to configure it.
            </Callout>
          )}
        </SettingsContainer>
      </PageBody>
    </PageContainer>
  );
}

function PublishingStatus({ grant }: { grant?: { enabled: boolean } | null }) {
  const status = !grant ? "off" : grant.enabled ? "on" : "paused";
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-sm",
        status === "on" ? "text-success" : status === "paused" ? "text-warning" : "text-text-dimmed"
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "on" ? "bg-success" : status === "paused" ? "bg-warning" : "bg-text-dimmed"
        )}
      />
      {status === "on" ? "Enabled" : status === "paused" ? "Paused" : "Not enabled"}
    </span>
  );
}
