import { getFormProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod";
import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { Result, fromPromise } from "neverthrow";
import { useEffect, useRef, useState } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { z } from "zod";
import { BuildSettingsFields } from "~/components/integrations/VercelBuildSettings";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PermissionLink } from "~/components/primitives/PermissionLink";
import { Select, SelectItem } from "~/components/primitives/Select";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import {
  redirectBackWithErrorMessage,
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import {
  type VercelOnboardingData,
  VercelSettingsPresenter,
} from "~/presenters/v3/VercelSettingsPresenter.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { requireUserId } from "~/services/session.server";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import {
  EnvironmentParamSchema,
  v3ProjectSettingsIntegrationsPath,
  vercelAppInstallPath,
  vercelResourcePath,
} from "~/utils/pathBuilder";
import {
  type EnvSlug,
  type SyncEnvVarsMapping,
  type VercelProjectIntegrationData,
  envSlugArrayField,
  getAvailableEnvSlugs,
  getAvailableEnvSlugsForBuildSettings,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { sanitizeVercelNextUrl } from "~/v3/vercel/vercelUrls.server";

export type ConnectedVercelProject = {
  id: string;
  vercelProjectId: string;
  vercelProjectName: string;
  vercelTeamId: string | null;
  integrationData: VercelProjectIntegrationData;
  createdAt: Date;
};

const safeJsonParse = Result.fromThrowable(
  (val: string) => JSON.parse(val) as Record<string, unknown>,
  () => null
);

function parseVercelStagingEnvironment(
  value: string | null | undefined
): { environmentId: string; displayName: string } | null {
  if (!value) return null;
  return safeJsonParse(value).match(
    (parsed) => {
      if (typeof parsed?.environmentId === "string" && typeof parsed?.displayName === "string") {
        return { environmentId: parsed.environmentId, displayName: parsed.displayName };
      }
      return null;
    },
    () => null
  );
}

// Sentinel values for the clearTriggerVersion hidden input. Used by the schema transform,
// the input's defaultValue, and the modal's submit helper — keep all three reading the same
// constants so they cannot drift.
const CLEAR_TRIGGER_VERSION_YES = "true";
const CLEAR_TRIGGER_VERSION_NO = "false";

const UpdateVercelConfigFormSchema = z.object({
  action: z.literal("update-config"),
  atomicBuilds: envSlugArrayField,
  pullEnvVarsBeforeBuild: envSlugArrayField,
  discoverEnvVars: envSlugArrayField,
  vercelStagingEnvironment: z.string().nullable().optional(),
  autoPromote: z
    .string()
    .optional()
    .transform((val) => val !== "false"),
  clearTriggerVersion: z
    .string()
    .optional()
    .transform((val) => val === CLEAR_TRIGGER_VERSION_YES),
});

const DisconnectVercelFormSchema = z.object({
  action: z.literal("disconnect"),
});

const CompleteOnboardingFormSchema = z.object({
  action: z.literal("complete-onboarding"),
  vercelStagingEnvironment: z.string().nullable().optional(),
  pullEnvVarsBeforeBuild: envSlugArrayField,
  atomicBuilds: envSlugArrayField,
  discoverEnvVars: envSlugArrayField,
  syncEnvVarsMapping: z.string().optional(),
  next: z.string().optional(),
  skipRedirect: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  origin: z.string().optional(),
});

const SkipOnboardingFormSchema = z.object({
  action: z.literal("skip-onboarding"),
});

const SelectVercelProjectFormSchema = z.object({
  action: z.literal("select-vercel-project"),
  vercelProjectId: z.string().min(1, "Please select a Vercel project"),
  vercelProjectName: z.string().min(1),
});

const UpdateEnvMappingFormSchema = z.object({
  action: z.literal("update-env-mapping"),
  vercelStagingEnvironment: z.string().nullable().optional(),
});

const DisableAutoAssignFormSchema = z.object({
  action: z.literal("disable-auto-assign"),
});

const VercelActionSchema = z.discriminatedUnion("action", [
  UpdateVercelConfigFormSchema,
  DisconnectVercelFormSchema,
  CompleteOnboardingFormSchema,
  SkipOnboardingFormSchema,
  SelectVercelProjectFormSchema,
  UpdateEnvMappingFormSchema,
  DisableAutoAssignFormSchema,
]);

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  const presenter = new VercelSettingsPresenter();
  const resultOrFail = await presenter.call({
    projectId: project.id,
    organizationId: project.organizationId,
  });

  if (resultOrFail.isErr()) {
    logger.error("Failed to load Vercel settings", {
      url: request.url,
      params,
      error: resultOrFail.error,
    });
    throw new Response("Failed to load Vercel settings", { status: 500 });
  }

  const result = resultOrFail.value;
  const url = new URL(request.url);
  const needsOnboarding = url.searchParams.get("vercelOnboarding") === "true";
  const vercelEnvironmentId = url.searchParams.get("vercelEnvironmentId") || undefined;

  let onboardingData: VercelOnboardingData | null = null;
  if (needsOnboarding) {
    onboardingData = await presenter.getOnboardingData(
      project.id,
      project.organizationId,
      vercelEnvironmentId
    );
  }

  const authInvalid = onboardingData?.authInvalid || result.authInvalid || false;
  const authError = onboardingData?.authError || result.authError;

  // Display flag for the connect/disconnect/configure controls — the action
  // enforces write:vercel independently. Permissive in OSS.
  const sessionAuth = await rbac.authenticateSession(request, {
    userId,
    organizationId: project.organizationId,
  });
  const canManageVercel = sessionAuth.ok
    ? sessionAuth.ability.can("write", { type: "vercel" })
    : true;

  return typedjson({
    ...result,
    authInvalid,
    authError,
    onboardingData,
    organizationSlug,
    projectSlug: projectParam,
    environmentSlug: envParam,
    projectId: project.id,
    organizationId: project.organizationId,
    canManageVercel,
  });
}

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: { action: "write", resource: { type: "vercel" } },
  },
  async ({ request, params, user }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: VercelActionSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    const settingsPath = v3ProjectSettingsIntegrationsPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    );

    const vercelService = new VercelIntegrationService();
    const { action: actionType } = submission.value;

    switch (actionType) {
      case "update-config": {
        const {
          atomicBuilds,
          pullEnvVarsBeforeBuild,
          discoverEnvVars,
          vercelStagingEnvironment,
          autoPromote,
          clearTriggerVersion,
        } = submission.value;

        const parsedStagingEnv = parseVercelStagingEnvironment(vercelStagingEnvironment);

        // Get the previous staging environment before updating
        const previousIntegration = await vercelService.getVercelProjectIntegration(project.id);
        const previousStagingEnvId =
          previousIntegration?.parsedIntegrationData.config?.vercelStagingEnvironment
            ?.environmentId ?? null;
        const newStagingEnvId = parsedStagingEnv?.environmentId ?? null;

        const result = await vercelService.updateVercelIntegrationConfig(project.id, {
          atomicBuilds,
          pullEnvVarsBeforeBuild,
          discoverEnvVars,
          vercelStagingEnvironment: parsedStagingEnv,
          autoPromote,
        });

        if (result) {
          // Sync staging TRIGGER_SECRET_KEY if the custom environment changed
          if (previousStagingEnvId !== newStagingEnvId) {
            await vercelService.syncStagingKeyForCustomEnvironment(
              project.id,
              previousStagingEnvId,
              newStagingEnvId
            );
          }

          // When atomic deployments are being disabled and the user confirmed clearing the pin,
          // remove TRIGGER_VERSION from Vercel production so future deploys don't stay pinned.
          // If the Vercel API call fails we still consider the settings save itself successful,
          // but tell the user so they can clear the env var manually from the Vercel dashboard.
          if (clearTriggerVersion && !atomicBuilds?.includes("prod")) {
            const cleared = await vercelService.clearTriggerVersionFromVercelProduction(project.id);
            if (!cleared) {
              return redirectWithErrorMessage(
                settingsPath,
                request,
                "Vercel settings saved, but failed to clear TRIGGER_VERSION on Vercel — please remove it manually from your Vercel project settings."
              );
            }
          }

          return redirectWithSuccessMessage(
            settingsPath,
            request,
            "Vercel settings updated successfully"
          );
        }

        return redirectWithErrorMessage(settingsPath, request, "Failed to update Vercel settings");
      }

      case "disconnect": {
        const success = await vercelService.disconnectVercelProject(project.id);

        if (success) {
          return redirectWithSuccessMessage(settingsPath, request, "Vercel project disconnected");
        }

        return redirectWithErrorMessage(
          settingsPath,
          request,
          "Failed to disconnect Vercel project"
        );
      }

      case "complete-onboarding": {
        const {
          vercelStagingEnvironment,
          pullEnvVarsBeforeBuild,
          atomicBuilds,
          discoverEnvVars,
          syncEnvVarsMapping,
          next,
          skipRedirect,
          origin,
        } = submission.value;

        const parsedStagingEnv = parseVercelStagingEnvironment(vercelStagingEnvironment);
        const parsedSyncEnvVarsMapping = syncEnvVarsMapping
          ? (safeJsonParse(syncEnvVarsMapping).unwrapOr(undefined) as
              | SyncEnvVarsMapping
              | undefined)
          : undefined;

        const result = await vercelService.completeOnboarding(project.id, {
          vercelStagingEnvironment: parsedStagingEnv,
          pullEnvVarsBeforeBuild,
          atomicBuilds,
          discoverEnvVars,
          syncEnvVarsMapping: parsedSyncEnvVarsMapping,
          origin: origin === "marketplace" ? "marketplace" : "dashboard",
        });

        if (result) {
          if (skipRedirect) {
            return json({ success: true });
          }

          if (next) {
            const sanitizedNext = sanitizeVercelNextUrl(next);
            if (sanitizedNext) {
              return json({ success: true, redirectTo: sanitizedNext });
            }
            logger.warn("Rejected next URL - not same-origin or vercel.com", { next });
          }

          return json({ success: true, redirectTo: settingsPath });
        }

        return redirectWithErrorMessage(settingsPath, request, "Failed to complete Vercel setup");
      }

      case "update-env-mapping": {
        const { vercelStagingEnvironment } = submission.value;

        const parsedStagingEnv = parseVercelStagingEnvironment(vercelStagingEnvironment);

        const result = await vercelService.updateVercelIntegrationConfig(project.id, {
          vercelStagingEnvironment: parsedStagingEnv,
        });

        if (result) {
          // During onboarding there's no previous custom environment — just upsert
          await vercelService.syncStagingKeyForCustomEnvironment(
            project.id,
            null,
            parsedStagingEnv?.environmentId ?? null
          );
          return json({ success: true });
        }

        return json(
          { success: false, error: "Failed to update environment mapping" },
          { status: 400 }
        );
      }

      case "skip-onboarding": {
        return redirectWithSuccessMessage(
          settingsPath,
          request,
          "Vercel integration setup skipped"
        );
      }

      case "select-vercel-project": {
        const { vercelProjectId, vercelProjectName } = submission.value;

        const selectResult = await fromPromise(
          vercelService.selectVercelProject({
            organizationId: project.organizationId,
            projectId: project.id,
            vercelProjectId,
            vercelProjectName,
            userId,
          }),
          (error) => error
        );

        if (selectResult.isErr()) {
          logger.error("Failed to select Vercel project", { error: selectResult.error });
          return json({
            error: "Failed to connect Vercel project. Please try again.",
          });
        }

        const { integration, syncResult } = selectResult.value;

        if (!syncResult.success && syncResult.errors.length > 0) {
          logger.warn("Failed to send trigger secrets to Vercel", {
            projectId: project.id,
            vercelProjectId,
            errors: syncResult.errors,
          });
        }

        return json({
          success: true,
          integrationId: integration.id,
          syncErrors: syncResult.errors,
        });
      }

      case "disable-auto-assign": {
        const orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationForProject(
          project.id
        );

        if (!orgIntegration) {
          return redirectWithErrorMessage(settingsPath, request, "No Vercel integration found");
        }

        const projectIntegration = await vercelService.getVercelProjectIntegration(project.id);

        if (!projectIntegration) {
          return redirectWithErrorMessage(settingsPath, request, "No Vercel project connected");
        }

        const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);

        const disableResult = await VercelIntegrationRepository.getVercelClient(
          orgIntegration
        ).andThen((client) =>
          VercelIntegrationRepository.disableAutoAssignCustomDomains(
            client,
            projectIntegration.parsedIntegrationData.vercelProjectId,
            teamId
          )
        );

        if (disableResult.isErr()) {
          logger.error("Failed to disable auto-assign custom domains", {
            error: disableResult.error,
          });
          return redirectWithErrorMessage(
            settingsPath,
            request,
            "Failed to disable auto-assign custom domains"
          );
        }

        return redirectWithSuccessMessage(
          settingsPath,
          request,
          "Auto-assign custom domains disabled"
        );
      }

      default: {
        submission.value satisfies never;
        return redirectBackWithErrorMessage(request, "Failed to process request");
      }
    }
  }
);

function VercelConnectionPrompt({
  organizationSlug,
  projectSlug,
  environmentSlug,
  hasOrgIntegration,
  isGitHubConnected,
  onOpenModal,
  isLoading,
  canManageVercel = true,
}: {
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  hasOrgIntegration: boolean;
  isGitHubConnected: boolean;
  onOpenModal?: () => void;
  isLoading?: boolean;
  canManageVercel?: boolean;
}) {
  const installPath = vercelAppInstallPath(organizationSlug, projectSlug);

  const handleConnectProject = () => {
    if (onOpenModal) {
      onOpenModal();
    }
  };

  const isLoadingProjects = isLoading ?? false;
  const isDisabled = isLoadingProjects || !onOpenModal;

  return (
    <Fieldset>
      <InputGroup fullWidth>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            {hasOrgIntegration ? (
              <>
                <Button
                  variant="secondary/medium"
                  onClick={handleConnectProject}
                  disabled={isDisabled || !canManageVercel}
                  tooltip={
                    canManageVercel
                      ? undefined
                      : "You don't have permission to manage the Vercel integration"
                  }
                  LeadingIcon={
                    isLoadingProjects
                      ? () => <SpinnerWhite className="size-4" />
                      : () => <VercelLogo className="-mx-1 size-4" />
                  }
                >
                  {isLoadingProjects ? "Loading projects..." : "Connect Vercel project"}
                </Button>
                <span className="flex items-center gap-1 text-xs text-text-dimmed">
                  <CheckCircleIcon className="size-4 text-success" /> Vercel app is installed
                </span>
                {!onOpenModal && (
                  <span className="text-xs text-amber-400">
                    Please reconnect Vercel to continue
                  </span>
                )}
              </>
            ) : (
              <>
                <PermissionLink
                  hasPermission={canManageVercel}
                  noPermissionTooltip="You don't have permission to manage the Vercel integration"
                  to={installPath}
                  variant="secondary/medium"
                  LeadingIcon={() => <VercelLogo className="-mx-1 size-4" />}
                >
                  Install Vercel app
                </PermissionLink>
              </>
            )}
          </div>
        </div>
      </InputGroup>
    </Fieldset>
  );
}

function VercelAuthInvalidBanner({
  organizationSlug,
  projectSlug,
  canManageVercel = true,
}: {
  organizationSlug: string;
  projectSlug: string;
  canManageVercel?: boolean;
}) {
  const installUrl = vercelAppInstallPath(organizationSlug, projectSlug);

  return (
    <Callout variant="error" className="mb-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <p className="mb-2 font-sans text-sm font-medium text-text-bright">
            Vercel connection expired
          </p>
          <p className="mb-3 font-sans text-xs text-text-dimmed">
            Your Vercel access token has expired or been revoked. Please reconnect to restore
            functionality.
          </p>
          <PermissionLink
            hasPermission={canManageVercel}
            noPermissionTooltip="You don't have permission to manage the Vercel integration"
            to={installUrl}
            variant="minimal/small"
            className="border-error/20 bg-error/10 text-error hover:bg-error/20"
          >
            Reconnect Vercel
          </PermissionLink>
        </div>
      </div>
    </Callout>
  );
}

function VercelGitHubWarning() {
  return (
    <Callout variant="warning" className="mb-4">
      <p className="font-sans text-xs font-normal text-text-dimmed">
        GitHub integration is not connected. Vercel integration cannot sync environment variables
        and link deployments without a properly installed GitHub integration.
      </p>
    </Callout>
  );
}

function envSlugLabel(slug: EnvSlug): string {
  switch (slug) {
    case "prod":
      return "Production";
    case "stg":
      return "Staging";
    case "preview":
      return "Preview";
    case "dev":
      return "Development";
  }
}

function ConnectedVercelProjectForm({
  connectedProject,
  hasStagingEnvironment,
  hasPreviewEnvironment,
  customEnvironments,
  autoAssignCustomDomains,
  currentTriggerVersion,
  currentTriggerVersionFetchFailed,
  organizationSlug,
  projectSlug,
  environmentSlug,
  canManageVercel = true,
}: {
  connectedProject: ConnectedVercelProject;
  hasStagingEnvironment: boolean;
  hasPreviewEnvironment: boolean;
  customEnvironments: Array<{ id: string; slug: string }>;
  autoAssignCustomDomains: boolean | null;
  currentTriggerVersion: string | null;
  currentTriggerVersionFetchFailed: boolean;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  canManageVercel?: boolean;
}) {
  const lastSubmission = useActionData() as any;
  const navigation = useNavigation();

  const [hasConfigChanges, setHasConfigChanges] = useState(false);
  const [configValues, setConfigValues] = useState({
    atomicBuilds: connectedProject.integrationData.config.atomicBuilds ?? [],
    pullEnvVarsBeforeBuild: connectedProject.integrationData.config.pullEnvVarsBeforeBuild ?? [],
    discoverEnvVars: connectedProject.integrationData.config.discoverEnvVars ?? [],
    vercelStagingEnvironment:
      connectedProject.integrationData.config.vercelStagingEnvironment ?? null,
    autoPromote: connectedProject.integrationData.config.autoPromote ?? true,
  });

  const originalAtomicBuilds = connectedProject.integrationData.config.atomicBuilds ?? [];
  const originalPullEnvVars = connectedProject.integrationData.config.pullEnvVarsBeforeBuild ?? [];
  const originalDiscoverEnvVars = connectedProject.integrationData.config.discoverEnvVars ?? [];
  const originalStagingEnv =
    connectedProject.integrationData.config.vercelStagingEnvironment ?? null;
  const originalAutoPromote = connectedProject.integrationData.config.autoPromote ?? true;

  useEffect(() => {
    const atomicBuildsChanged =
      JSON.stringify([...configValues.atomicBuilds].sort()) !==
      JSON.stringify([...originalAtomicBuilds].sort());
    const pullEnvVarsChanged =
      JSON.stringify([...configValues.pullEnvVarsBeforeBuild].sort()) !==
      JSON.stringify([...originalPullEnvVars].sort());
    const discoverEnvVarsChanged =
      JSON.stringify([...configValues.discoverEnvVars].sort()) !==
      JSON.stringify([...originalDiscoverEnvVars].sort());
    const stagingEnvChanged =
      configValues.vercelStagingEnvironment?.environmentId !== originalStagingEnv?.environmentId;
    const autoPromoteChanged = configValues.autoPromote !== originalAutoPromote;

    setHasConfigChanges(
      atomicBuildsChanged ||
        pullEnvVarsChanged ||
        discoverEnvVarsChanged ||
        stagingEnvChanged ||
        autoPromoteChanged
    );
  }, [
    configValues,
    originalAtomicBuilds,
    originalPullEnvVars,
    originalDiscoverEnvVars,
    originalStagingEnv,
    originalAutoPromote,
  ]);

  const [configForm, _fields] = useForm({
    id: "update-vercel-config",
    lastResult: lastSubmission,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parseWithZod(formData, {
        schema: UpdateVercelConfigFormSchema,
      });
    },
  });

  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const clearTriggerVersionInputRef = useRef<HTMLInputElement>(null);
  const [showClearDialog, setShowClearDialog] = useState(false);

  // Modal trigger uses the page-load state of atomicBuilds, not whatever changed in-session,
  // because clearing TRIGGER_VERSION only makes sense when atomic was actually on at load time.
  // If the Vercel lookup failed we still prompt — we don't know whether a pin exists, so the
  // user needs to make the call explicitly rather than silently leaving prod pinned.
  const wasAtomicEnabledAtLoad = originalAtomicBuilds.includes("prod");
  const isAtomicNowDisabled = !configValues.atomicBuilds.includes("prod");
  const shouldPromptClearOnSave =
    wasAtomicEnabledAtLoad &&
    isAtomicNowDisabled &&
    (Boolean(currentTriggerVersion) || currentTriggerVersionFetchFailed);

  const submitWithClearChoice = (clear: boolean) => {
    if (clearTriggerVersionInputRef.current) {
      clearTriggerVersionInputRef.current.value = clear
        ? CLEAR_TRIGGER_VERSION_YES
        : CLEAR_TRIGGER_VERSION_NO;
    }
    setShowClearDialog(false);
    // Conform owns the form's React ref via {...configForm.props}, so look it up by id
    // (set via useForm({ id: "update-vercel-config" })) rather than fighting for the ref.
    const form = document.getElementById("update-vercel-config") as HTMLFormElement | null;
    form?.requestSubmit(saveButtonRef.current ?? undefined);
  };

  const isConfigLoading =
    navigation.formData?.get("action") === "update-config" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const actionUrl = vercelResourcePath(organizationSlug, projectSlug, environmentSlug);

  const availableEnvSlugs = getAvailableEnvSlugs(hasStagingEnvironment, hasPreviewEnvironment);
  const availableEnvSlugsForBuildSettings = getAvailableEnvSlugsForBuildSettings(
    hasStagingEnvironment,
    hasPreviewEnvironment
  );

  const disabledEnvSlugsForBuildSettings: Partial<Record<EnvSlug, string>> | undefined =
    hasStagingEnvironment && !configValues.vercelStagingEnvironment
      ? { stg: "Map a custom Vercel environment to Staging to enable this" }
      : undefined;

  const _formatSelectedEnvs = (
    selected: EnvSlug[],
    availableSlugs: EnvSlug[] = availableEnvSlugs
  ): string => {
    if (selected.length === 0) return "None selected";
    if (selected.length === availableSlugs.length) return "All environments";
    return selected.map(envSlugLabel).join(", ");
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between rounded-sm border bg-grid-dimmed p-2">
        <div className="flex items-center gap-2">
          <VercelLogo className="size-4" />
          <span className="max-w-52 truncate text-sm text-text-bright">
            {connectedProject.vercelProjectName}
          </span>
          <span className="text-xs text-text-dimmed">
            <DateTime
              date={connectedProject.createdAt}
              includeTime={false}
              includeSeconds={false}
              showTimezone={false}
              showTooltip={false}
            />
          </span>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button
              variant="minimal/small"
              disabled={!canManageVercel}
              tooltip={
                canManageVercel
                  ? undefined
                  : "You don't have permission to manage the Vercel integration"
              }
            >
              Disconnect
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>Disconnect Vercel project</DialogHeader>
            <div className="flex flex-col gap-3 pt-3">
              <Paragraph className="mb-1">
                Are you sure you want to disconnect{" "}
                <span className="font-semibold">{connectedProject.vercelProjectName}</span>? This
                will stop pulling environment variables and disable atomic deployments.
              </Paragraph>
              <FormButtons
                confirmButton={
                  <Form method="post" action={actionUrl}>
                    <input type="hidden" name="action" value="disconnect" />
                    <Button type="submit" variant="danger/medium">
                      Disconnect project
                    </Button>
                  </Form>
                }
                cancelButton={
                  <DialogClose asChild>
                    <Button variant="tertiary/medium">Cancel</Button>
                  </DialogClose>
                }
              />
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Configuration form */}
      <Form method="post" action={actionUrl} {...getFormProps(configForm)}>
        <input
          type="hidden"
          name="atomicBuilds"
          value={JSON.stringify(configValues.atomicBuilds)}
        />
        <input
          type="hidden"
          name="pullEnvVarsBeforeBuild"
          value={JSON.stringify(configValues.pullEnvVarsBeforeBuild)}
        />
        <input
          type="hidden"
          name="discoverEnvVars"
          value={JSON.stringify(configValues.discoverEnvVars)}
        />
        <input
          type="hidden"
          name="vercelStagingEnvironment"
          value={
            configValues.vercelStagingEnvironment
              ? JSON.stringify(configValues.vercelStagingEnvironment)
              : ""
          }
        />
        <input type="hidden" name="autoPromote" value={String(configValues.autoPromote)} />
        {/* Flipped to CLEAR_TRIGGER_VERSION_YES by the clear-pinned-version modal on submit. */}
        <input
          type="hidden"
          name="clearTriggerVersion"
          defaultValue={CLEAR_TRIGGER_VERSION_NO}
          ref={clearTriggerVersionInputRef}
        />

        <Fieldset>
          <InputGroup fullWidth>
            <div className="flex flex-col gap-4">
              {/* Staging environment mapping */}
              {hasStagingEnvironment && customEnvironments && customEnvironments.length > 0 && (
                <div>
                  <Label>Map Vercel environment to Staging</Label>
                  <Hint className="mb-2">
                    Select which custom Vercel environment should map to Trigger.dev's Staging
                    environment.
                  </Hint>
                  <Select
                    value={configValues.vercelStagingEnvironment?.environmentId || ""}
                    setValue={(value) => {
                      if (!Array.isArray(value)) {
                        const env = customEnvironments?.find((e) => e.id === value);
                        setConfigValues((prev) => {
                          const next = {
                            ...prev,
                            vercelStagingEnvironment: env
                              ? { environmentId: env.id, displayName: env.slug }
                              : null,
                          };
                          // When clearing the staging mapping, strip "stg" from build settings
                          if (!env) {
                            next.pullEnvVarsBeforeBuild = prev.pullEnvVarsBeforeBuild.filter(
                              (s) => s !== "stg"
                            );
                            next.discoverEnvVars = prev.discoverEnvVars.filter((s) => s !== "stg");
                          }
                          return next;
                        });
                      }
                    }}
                    items={[{ id: "", slug: "None" }, ...customEnvironments]}
                    variant="tertiary/small"
                    placeholder="Select environment"
                    dropdownIcon
                    text={configValues.vercelStagingEnvironment?.displayName || "None"}
                  >
                    {[
                      <SelectItem key="" value="">
                        None
                      </SelectItem>,
                      ...customEnvironments.map((env) => (
                        <SelectItem key={env.id} value={env.id}>
                          {env.slug}
                        </SelectItem>
                      )),
                    ]}
                  </Select>
                </div>
              )}

              <BuildSettingsFields
                availableEnvSlugs={availableEnvSlugsForBuildSettings}
                pullEnvVarsBeforeBuild={configValues.pullEnvVarsBeforeBuild}
                onPullEnvVarsChange={(slugs) =>
                  setConfigValues((prev) => ({ ...prev, pullEnvVarsBeforeBuild: slugs }))
                }
                discoverEnvVars={configValues.discoverEnvVars}
                onDiscoverEnvVarsChange={(slugs) =>
                  setConfigValues((prev) => ({ ...prev, discoverEnvVars: slugs }))
                }
                atomicBuilds={configValues.atomicBuilds}
                onAtomicBuildsChange={(slugs) =>
                  setConfigValues((prev) => ({ ...prev, atomicBuilds: slugs }))
                }
                envVarsConfigLink={`/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/environment-variables`}
                disabledEnvSlugs={disabledEnvSlugsForBuildSettings}
                autoPromote={configValues.autoPromote}
                onAutoPromoteChange={(value) =>
                  setConfigValues((prev) => ({ ...prev, autoPromote: value }))
                }
                currentTriggerVersion={currentTriggerVersion}
                currentTriggerVersionFetchFailed={currentTriggerVersionFetchFailed}
                hideSectionToggles
              />

              {/* Warning: autoAssignCustomDomains must be disabled for atomic deployments */}
              {autoAssignCustomDomains !== false && configValues.atomicBuilds.includes("prod") && (
                <Callout variant="warning">
                  <div className="flex flex-col gap-2">
                    <p className="font-sans text-xs font-normal text-text-dimmed">
                      Atomic deployments require the "Auto-assign Custom Domains" setting to be
                      disabled on your Vercel project. Without this, Vercel will promote deployments
                      before Trigger.dev is ready.
                    </p>
                    <Form method="post" action={actionUrl}>
                      <input type="hidden" name="action" value="disable-auto-assign" />
                      <Button
                        type="submit"
                        variant="tertiary/small"
                        disabled={
                          navigation.formData?.get("action") === "disable-auto-assign" &&
                          (navigation.state === "submitting" || navigation.state === "loading")
                        }
                        LeadingIcon={
                          navigation.formData?.get("action") === "disable-auto-assign" &&
                          (navigation.state === "submitting" || navigation.state === "loading")
                            ? SpinnerWhite
                            : undefined
                        }
                      >
                        Disable auto-assign custom domains
                      </Button>
                    </Form>
                  </div>
                </Callout>
              )}
            </div>

            <FormError>{configForm.errors}</FormError>
          </InputGroup>

          <FormButtons
            confirmButton={
              <Button
                ref={saveButtonRef}
                type="submit"
                name="action"
                value="update-config"
                variant="secondary/small"
                disabled={isConfigLoading || !hasConfigChanges || !canManageVercel}
                tooltip={
                  canManageVercel
                    ? undefined
                    : "You don't have permission to manage the Vercel integration"
                }
                LeadingIcon={isConfigLoading ? SpinnerWhite : undefined}
                onClick={(event) => {
                  if (shouldPromptClearOnSave) {
                    event.preventDefault();
                    setShowClearDialog(true);
                  }
                }}
              >
                Save
              </Button>
            }
          />
        </Fieldset>
      </Form>

      <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>Clear TRIGGER_VERSION from Vercel?</DialogHeader>
          <div className="flex flex-col gap-3 pt-3">
            {currentTriggerVersion ? (
              <Paragraph className="mb-1">
                Atomic deployments are being turned off. The{" "}
                <span className="font-mono text-text-bright">TRIGGER_VERSION</span> env var on your
                Vercel production environment is currently set to{" "}
                <span className="font-mono text-text-bright">{currentTriggerVersion}</span>.
              </Paragraph>
            ) : (
              <Paragraph className="mb-1">
                Atomic deployments are being turned off. We couldn't reach Vercel to confirm whether{" "}
                <span className="font-mono text-text-bright">TRIGGER_VERSION</span> is currently set
                on your Vercel production environment, so please verify in the Vercel dashboard.
              </Paragraph>
            )}
            <Paragraph className="mb-1">
              If you leave it, your Vercel project will stay pinned to this version. Since atomic
              deployments will be off, Trigger.dev will no longer update this variable, and future
              Vercel deploys will continue using this pinned version. We recommend clearing it.
            </Paragraph>
            <FormButtons
              confirmButton={
                <div className="flex gap-2">
                  <Button variant="secondary/medium" onClick={() => submitWithClearChoice(false)}>
                    Keep pinned
                  </Button>
                  <Button variant="primary/medium" onClick={() => submitWithClearChoice(true)}>
                    Clear and disable
                  </Button>
                </div>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button variant="tertiary/medium">Cancel</Button>
                </DialogClose>
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function VercelSettingsPanel({
  organizationSlug,
  projectSlug,
  environmentSlug,
  onOpenVercelModal,
  isLoadingVercelData,
}: {
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  onOpenVercelModal?: () => void;
  isLoadingVercelData?: boolean;
}) {
  const fetcher = useTypedFetcher<typeof loader>();
  const _location = useLocation();
  const data = fetcher.data;
  const [hasError, _setHasError] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  useEffect(() => {
    if (!data?.authInvalid && !hasError && !data && !hasFetched) {
      fetcher.load(vercelResourcePath(organizationSlug, projectSlug, environmentSlug));
      setHasFetched(true);
    }
  }, [
    organizationSlug,
    projectSlug,
    environmentSlug,
    data?.authInvalid,
    hasError,
    data,
    hasFetched,
  ]);

  if (hasError) {
    return (
      <div className="rounded-sm border border-rose-500/40 bg-rose-500/10 p-4">
        <div className="flex items-start gap-3">
          <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0 text-rose-500" />
          <div>
            <p className="font-medium text-rose-400">Failed to load Vercel settings</p>
            <p className="mt-1 text-sm text-rose-300">
              There was an error loading the Vercel integration settings. Please refresh the page to
              try again.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (fetcher.state === "loading" && !data) {
    return (
      <div className="flex items-center gap-2 text-text-dimmed">
        <SpinnerWhite className="size-4" />
        <span className="text-sm">Loading Vercel settings...</span>
      </div>
    );
  }

  if (!data || !data.enabled) {
    return null;
  }

  const showGitHubWarning = data.connectedProject && !data.isGitHubConnected;
  const showAuthInvalid = data.authInvalid || data.onboardingData?.authInvalid;

  if (data.connectedProject) {
    return (
      <>
        {showAuthInvalid && (
          <VercelAuthInvalidBanner
            organizationSlug={organizationSlug}
            projectSlug={projectSlug}
            canManageVercel={data.canManageVercel}
          />
        )}
        {showGitHubWarning && <VercelGitHubWarning />}
        {!showAuthInvalid && (
          <ConnectedVercelProjectForm
            connectedProject={data.connectedProject}
            hasStagingEnvironment={data.hasStagingEnvironment}
            hasPreviewEnvironment={data.hasPreviewEnvironment}
            customEnvironments={data.customEnvironments}
            autoAssignCustomDomains={data.autoAssignCustomDomains ?? null}
            currentTriggerVersion={data.currentTriggerVersion ?? null}
            currentTriggerVersionFetchFailed={data.currentTriggerVersionFetchFailed ?? false}
            organizationSlug={organizationSlug}
            projectSlug={projectSlug}
            environmentSlug={environmentSlug}
            canManageVercel={data.canManageVercel}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {showAuthInvalid && (
        <VercelAuthInvalidBanner organizationSlug={organizationSlug} projectSlug={projectSlug} />
      )}
      {!showAuthInvalid && (
        <>
          <VercelConnectionPrompt
            organizationSlug={organizationSlug}
            projectSlug={projectSlug}
            environmentSlug={environmentSlug}
            hasOrgIntegration={data.hasOrgIntegration}
            isGitHubConnected={data.isGitHubConnected}
            onOpenModal={showAuthInvalid ? undefined : onOpenVercelModal}
            isLoading={isLoadingVercelData}
            canManageVercel={data.canManageVercel}
          />
          <Hint>
            {data.hasOrgIntegration
              ? "Connect your Vercel project to pull environment variables and trigger builds automatically."
              : "Install the Vercel app to connect your projects and pull environment variables."}
          </Hint>
          {!data.isGitHubConnected && (
            <Hint>
              GitHub integration is not connected. Vercel integration cannot sync environment
              variables and link deployments without a properly installed GitHub integration.
            </Hint>
          )}
        </>
      )}
    </div>
  );
}

import { VercelOnboardingModal } from "~/components/integrations/VercelOnboardingModal";

export { VercelOnboardingModal, VercelSettingsPanel };
