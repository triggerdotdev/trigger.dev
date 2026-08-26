import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod";
import { Form, useActionData, useNavigation, useSearchParams } from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import {
  SettingsActions,
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  redirectBackWithErrorMessage,
  redirectBackWithSuccessMessage,
} from "~/models/message.server";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import { logger } from "~/services/logger.server";
import { ProjectSettingsService } from "~/services/projectSettings.server";
import { ProjectSettingsPresenter } from "~/services/projectSettingsPresenter.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema, v3BillingPath, vercelResourcePath } from "~/utils/pathBuilder";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { type BuildSettings } from "~/v3/buildSettings";
import { GitHubSettingsPanel } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github";
import type { loader as vercelLoader } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.vercel";
import {
  VercelOnboardingModal,
  VercelSettingsPanel,
} from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.vercel";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Integrations");

export const handle = { pageTitle: "Integrations" };

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    // No hard authorization: the page renders a PermissionDenied panel for
    // roles that can't manage any integration (see canManageIntegrations).
  },
  async ({ params, user, ability }) => {
    const { projectParam, organizationSlug } = params;

    const canManageBuildSettings = ability.can("write", { type: "github" });
    const canManageIntegrations =
      canManageBuildSettings || ability.can("write", { type: "vercel" });

    if (!canManageIntegrations) {
      throwPermissionDenied("With your current role, you can't manage integrations.");
    }

    const projectSettingsPresenter = new ProjectSettingsPresenter();
    const resultOrFail = await projectSettingsPresenter.getProjectSettings(
      organizationSlug,
      projectParam,
      user.id
    );

    if (resultOrFail.isErr()) {
      switch (resultOrFail.error.type) {
        case "project_not_found": {
          throw new Response(undefined, {
            status: 404,
            statusText: "Project not found",
          });
        }
        case "other":
        default: {
          resultOrFail.error.type satisfies "other";

          logger.error("Failed loading project settings", {
            error: resultOrFail.error,
          });
          throw new Response(undefined, {
            status: 400,
            statusText: "Something went wrong, please try again!",
          });
        }
      }
    }

    const { gitHubApp, buildSettings } = resultOrFail.value;

    return typedjson({
      githubAppEnabled: gitHubApp.enabled,
      buildSettings,
      vercelIntegrationEnabled: OrgIntegrationRepository.isVercelSupported,
      canManageBuildSettings,
    });
  }
);

const UpdateBuildSettingsFormSchema = z.object({
  action: z.literal("update-build-settings"),
  triggerConfigFilePath: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val ? val.replace(/^\/+/, "") : val))
    .refine((val) => !val || val.length <= 255, {
      message: "Config file path must not exceed 255 characters",
    }),
  installCommand: z
    .string()
    .trim()
    .optional()
    .refine((val) => !val || !val.includes("\n"), {
      message: "Install command must be a single line",
    })
    .refine((val) => !val || val.length <= 500, {
      message: "Install command must not exceed 500 characters",
    }),
  preBuildCommand: z
    .string()
    .trim()
    .optional()
    .refine((val) => !val || !val.includes("\n"), {
      message: "Pre-build command must be a single line",
    })
    .refine((val) => !val || val.length <= 500, {
      message: "Pre-build command must not exceed 500 characters",
    }),
  // Positive checkbox in the UI ("Use native build server"). It is checked by
  // default; we store the inverse as `disableNativeBuildServer`.
  useNativeBuildServer: z
    .string()
    .optional()
    .transform((val) => val === "on"),
});

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    // Build settings configure the Git-based deploy, so gate on write:github
    // (a restricted role can view neither this page nor mutate via a POST).
    authorization: { action: "write", resource: { type: "github" } },
  },
  async ({ request, params, user }) => {
    const { organizationSlug, projectParam } = params;

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: UpdateBuildSettingsFormSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    const projectSettingsService = new ProjectSettingsService();
    const membershipResultOrFail = await projectSettingsService.verifyProjectMembership(
      organizationSlug,
      projectParam,
      user.id
    );

    if (membershipResultOrFail.isErr()) {
      return json({ errors: { body: membershipResultOrFail.error.type } }, { status: 404 });
    }

    const { projectId } = membershipResultOrFail.value;

    const { installCommand, preBuildCommand, triggerConfigFilePath, useNativeBuildServer } =
      submission.value;

    const resultOrFail = await projectSettingsService.updateBuildSettings(projectId, {
      installCommand: installCommand || undefined,
      preBuildCommand: preBuildCommand || undefined,
      triggerConfigFilePath: triggerConfigFilePath || undefined,
      // Native build server is the default, so we only persist the opt-out.
      disableNativeBuildServer: useNativeBuildServer ? undefined : true,
    });

    if (resultOrFail.isErr()) {
      switch (resultOrFail.error.type) {
        case "other":
        default: {
          resultOrFail.error.type satisfies "other";

          logger.error("Failed to update build settings", {
            error: resultOrFail.error,
          });
          return redirectBackWithErrorMessage(request, "Failed to update build settings");
        }
      }
    }

    return redirectBackWithSuccessMessage(request, "Build settings updated successfully");
  }
);

export default function IntegrationsSettingsPage() {
  const { githubAppEnabled, buildSettings, vercelIntegrationEnabled, canManageBuildSettings } =
    useTypedLoaderData<typeof loader>();
  const project = useProject();
  const organization = useOrganization();
  const environment = useEnvironment();
  const [searchParams, setSearchParams] = useSearchParams();

  // Vercel onboarding modal state
  const hasQueryParam = searchParams.get("vercelOnboarding") === "true";
  const nextUrl = searchParams.get("next");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const vercelFetcher = useTypedFetcher<typeof vercelLoader>();
  const loadVercelOnboarding = vercelFetcher.load;
  const onboardingData = vercelFetcher.data?.onboardingData ?? null;
  const hasVercelFetcherData = vercelFetcher.data !== undefined;
  const onboardingDataUnavailable =
    hasVercelFetcherData && vercelFetcher.state === "idle" && onboardingData === null;
  const vercelOnboardingPath = `${vercelResourcePath(
    organization.slug,
    project.slug,
    environment.slug
  )}?vercelOnboarding=true`;

  // Helper to open modal and ensure query param is present
  const openVercelOnboarding = useCallback(() => {
    setIsModalOpen(true);
    // Ensure query param is present to maintain state during form submissions
    if (!hasQueryParam) {
      setSearchParams((prev) => {
        prev.set("vercelOnboarding", "true");
        return prev;
      });
    }
  }, [hasQueryParam, setSearchParams]);

  const closeVercelOnboarding = useCallback(() => {
    // Remove query param if present
    if (hasQueryParam) {
      setSearchParams((prev) => {
        prev.delete("vercelOnboarding");
        return prev;
      });
    }
    // Close modal
    setIsModalOpen(false);
  }, [hasQueryParam, setSearchParams]);

  // When query param is present, handle modal opening
  // Note: We don't close the modal based on data state during onboarding - only when explicitly closed
  useEffect(() => {
    if (hasQueryParam && vercelIntegrationEnabled) {
      // Ensure query param is present and modal is open
      if (onboardingData && vercelFetcher.state === "idle") {
        // Data is loaded, ensure modal is open (query param takes precedence)
        if (!isModalOpen) {
          // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
          openVercelOnboarding();
        }
      } else if (vercelFetcher.state === "idle" && !hasVercelFetcherData) {
        // Load onboarding data
        loadVercelOnboarding(vercelOnboardingPath);
      }
    } else if (!hasQueryParam && isModalOpen) {
      // Query param removed but modal is open, close modal
      setIsModalOpen(false);
    }
  }, [
    hasQueryParam,
    vercelIntegrationEnabled,
    onboardingData,
    hasVercelFetcherData,
    vercelFetcher.state,
    isModalOpen,
    openVercelOnboarding,
    loadVercelOnboarding,
    vercelOnboardingPath,
  ]);

  // Ensure modal stays open when query param is present (even after data reloads)
  // This is a safeguard to prevent the modal from closing during form submissions
  useEffect(() => {
    if (hasQueryParam && !isModalOpen) {
      // Query param is present but modal is closed, open it
      // This ensures the modal stays open during the onboarding flow
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      openVercelOnboarding();
    }
  }, [hasQueryParam, isModalOpen, openVercelOnboarding]);

  // When data finishes loading (from query param), ensure modal is open
  useEffect(() => {
    if (hasQueryParam && onboardingData && vercelFetcher.state === "idle") {
      // Data loaded and query param is present, ensure modal is open
      if (!isModalOpen) {
        // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
        openVercelOnboarding();
      }
    }
  }, [hasQueryParam, onboardingData, vercelFetcher.state, isModalOpen, openVercelOnboarding]);

  // Track if we're waiting for data from button click (not query param)
  const waitingForButtonClickRef = useRef(false);

  // Handle opening modal from button click (without query param)
  const handleOpenVercelModal = useCallback(() => {
    // Add query param to maintain state during form submissions
    if (!hasQueryParam) {
      setSearchParams((prev) => {
        prev.set("vercelOnboarding", "true");
        return prev;
      });
    }

    if (onboardingData) {
      // Data already loaded, open modal immediately
      openVercelOnboarding();
    } else {
      // Need to load data first, mark that we're waiting for button click
      waitingForButtonClickRef.current = true;
      loadVercelOnboarding(vercelOnboardingPath);
    }
  }, [
    loadVercelOnboarding,
    vercelOnboardingPath,
    onboardingData,
    setSearchParams,
    hasQueryParam,
    openVercelOnboarding,
  ]);

  // When data loads from button click, open modal
  useEffect(() => {
    if (waitingForButtonClickRef.current && onboardingData && vercelFetcher.state === "idle") {
      // Data loaded from button click, open modal and ensure query param is present
      waitingForButtonClickRef.current = false;
      openVercelOnboarding();
    }
  }, [onboardingData, vercelFetcher.state, openVercelOnboarding]);

  return (
    <>
      <SettingsContainer className="md:mt-6">
        {githubAppEnabled && (
          <>
            <SettingsSection>
              <SettingsHeader title="Git settings" />
              <GitHubSettingsPanel
                organizationSlug={organization.slug}
                projectSlug={project.slug}
                environmentSlug={environment.slug}
                billingPath={v3BillingPath({ slug: organization.slug })}
                layout="settings"
              />
            </SettingsSection>

            {vercelIntegrationEnabled && (
              <SettingsSection>
                <SettingsHeader title="Vercel integration" />
                <VercelSettingsPanel
                  organizationSlug={organization.slug}
                  projectSlug={project.slug}
                  environmentSlug={environment.slug}
                  onOpenVercelModal={handleOpenVercelModal}
                  isLoadingVercelData={
                    vercelFetcher.state === "loading" || vercelFetcher.state === "submitting"
                  }
                />
              </SettingsSection>
            )}
          </>
        )}

        <SettingsSection>
          <SettingsHeader
            title="Build settings"
            description={
              <>
                Applies to deployments triggered from GitHub, and CLI deployments run with the{" "}
                <InlineCode variant="extra-small" className="whitespace-nowrap">
                  --native-build-server
                </InlineCode>{" "}
                flag.
              </>
            }
          />
          <BuildSettingsForm
            buildSettings={buildSettings ?? {}}
            canManageBuildSettings={canManageBuildSettings}
          />
        </SettingsSection>
      </SettingsContainer>

      {/* Vercel Onboarding Modal */}
      {vercelIntegrationEnabled && (
        <VercelOnboardingModal
          isOpen={isModalOpen}
          onClose={closeVercelOnboarding}
          onboardingData={onboardingData}
          organizationSlug={organization.slug}
          projectSlug={project.slug}
          environmentSlug={environment.slug}
          hasStagingEnvironment={vercelFetcher.data?.hasStagingEnvironment ?? false}
          hasPreviewEnvironment={vercelFetcher.data?.hasPreviewEnvironment ?? false}
          hasOrgIntegration={vercelFetcher.data?.hasOrgIntegration ?? false}
          onboardingDataUnavailable={onboardingDataUnavailable}
          nextUrl={nextUrl ?? undefined}
          vercelManageAccessUrl={vercelFetcher.data?.vercelManageAccessUrl}
          onDataReload={(vercelEnvironmentId) => {
            loadVercelOnboarding(
              `${vercelOnboardingPath}${
                vercelEnvironmentId
                  ? `&vercelEnvironmentId=${encodeURIComponent(vercelEnvironmentId)}`
                  : ""
              }`
            );
          }}
        />
      )}
    </>
  );
}

function BuildSettingsForm({
  buildSettings,
  canManageBuildSettings = true,
}: {
  buildSettings: BuildSettings;
  canManageBuildSettings?: boolean;
}) {
  const lastSubmission = useActionData() as any;
  const navigation = useNavigation();

  const [hasBuildSettingsChanges, setHasBuildSettingsChanges] = useState(false);
  // The native build server is enabled by default; it's only off when the
  // project has explicitly opted out via `disableNativeBuildServer`.
  const nativeBuildServerEnabled = buildSettings?.disableNativeBuildServer !== true;
  const [buildSettingsValues, setBuildSettingsValues] = useState({
    preBuildCommand: buildSettings?.preBuildCommand || "",
    installCommand: buildSettings?.installCommand || "",
    triggerConfigFilePath: buildSettings?.triggerConfigFilePath || "",
    useNativeBuildServer: nativeBuildServerEnabled,
  });

  useEffect(() => {
    const hasChanges =
      buildSettingsValues.preBuildCommand !== (buildSettings?.preBuildCommand || "") ||
      buildSettingsValues.installCommand !== (buildSettings?.installCommand || "") ||
      buildSettingsValues.triggerConfigFilePath !== (buildSettings?.triggerConfigFilePath || "") ||
      buildSettingsValues.useNativeBuildServer !== nativeBuildServerEnabled;
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
    setHasBuildSettingsChanges(hasChanges);
  }, [buildSettingsValues, buildSettings, nativeBuildServerEnabled]);

  const [buildSettingsForm, fields] = useForm({
    id: "update-build-settings",
    lastResult: lastSubmission,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parseWithZod(formData, {
        schema: UpdateBuildSettingsFormSchema,
      });
    },
  });

  const isBuildSettingsLoading =
    navigation.formData?.get("action") === "update-build-settings" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  return (
    <Form method="post" {...getFormProps(buildSettingsForm)}>
      <SettingsRow
        align="start"
        htmlFor={fields.triggerConfigFilePath.id}
        title="Trigger config file"
        description="Path relative to your repo root."
        action={
          <SettingsControl>
            <Input
              {...getInputProps(fields.triggerConfigFilePath, { type: "text" })}
              variant="medium"
              defaultValue={buildSettings?.triggerConfigFilePath || ""}
              placeholder="trigger.config.ts"
              onChange={(e) => {
                setBuildSettingsValues((prev) => ({
                  ...prev,
                  triggerConfigFilePath: e.target.value,
                }));
              }}
            />
            <FormError id={fields.triggerConfigFilePath.errorId}>
              {fields.triggerConfigFilePath.errors}
            </FormError>
          </SettingsControl>
        }
      />

      <SettingsRow
        align="start"
        htmlFor={fields.installCommand.id}
        title="Install command"
        description="Runs from your repo root. Auto-detected by default."
        action={
          <SettingsControl>
            <Input
              {...getInputProps(fields.installCommand, { type: "text" })}
              variant="medium"
              defaultValue={buildSettings?.installCommand || ""}
              placeholder="pnpm install"
              onChange={(e) => {
                setBuildSettingsValues((prev) => ({
                  ...prev,
                  installCommand: e.target.value,
                }));
              }}
            />
            <FormError id={fields.installCommand.errorId}>
              {fields.installCommand.errors?.join(", ")}
            </FormError>
          </SettingsControl>
        }
      />
      <SettingsRow
        align="start"
        htmlFor={fields.preBuildCommand.id}
        title="Pre-build command"
        description="Runs from your repo root, before the build."
        action={
          <SettingsControl>
            <Input
              {...getInputProps(fields.preBuildCommand, { type: "text" })}
              variant="medium"
              defaultValue={buildSettings?.preBuildCommand || ""}
              placeholder="npm run prisma:generate"
              onChange={(e) => {
                setBuildSettingsValues((prev) => ({
                  ...prev,
                  preBuildCommand: e.target.value,
                }));
              }}
            />
            <FormError id={fields.preBuildCommand.errorId}>
              {fields.preBuildCommand.errors?.join(", ")}
            </FormError>
          </SettingsControl>
        }
      />

      <SettingsRow
        title="Use native build server"
        description="Builds without an external build provider. Requires trigger.dev v4.2.0 or newer."
        action={
          <Switch
            variant="medium"
            name={fields.useNativeBuildServer.name}
            defaultChecked={nativeBuildServerEnabled}
            onCheckedChange={(isChecked) => {
              setBuildSettingsValues((prev) => ({
                ...prev,
                useNativeBuildServer: isChecked,
              }));
            }}
          />
        }
      />

      <FormError id={fields.useNativeBuildServer.errorId}>
        {fields.useNativeBuildServer.errors}
      </FormError>
      <FormError>{buildSettingsForm.errors}</FormError>

      <SettingsActions>
        <Button
          type="submit"
          name="action"
          value="update-build-settings"
          variant="secondary/small"
          disabled={isBuildSettingsLoading || !hasBuildSettingsChanges || !canManageBuildSettings}
          tooltip={
            canManageBuildSettings
              ? undefined
              : "You don't have permission to manage build settings"
          }
          LeadingIcon={isBuildSettingsLoading ? SpinnerWhite : undefined}
        >
          Save
        </Button>
      </SettingsActions>
    </Form>
  );
}

function SettingsControl({ children }: { children: React.ReactNode }) {
  return <div className="flex w-64 flex-col gap-1">{children}</div>;
}
