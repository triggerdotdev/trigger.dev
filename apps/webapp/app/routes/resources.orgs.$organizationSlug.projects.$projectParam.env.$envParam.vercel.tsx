import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import {
  Form,
  useActionData,
  useFetcher,
  useNavigation,
  useLocation,
} from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
} from "@remix-run/server-runtime";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { DialogClose } from "@radix-ui/react-dialog";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { DateTime } from "~/components/primitives/DateTime";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { BuildSettingsFields } from "~/components/integrations/VercelBuildSettings";
import {
  redirectBackWithErrorMessage,
  redirectWithSuccessMessage,
  redirectWithErrorMessage,
} from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { sanitizeVercelNextUrl } from "~/v3/vercel/vercelUrls.server";
import { EnvironmentParamSchema, v3ProjectSettingsPath, vercelAppInstallPath, vercelResourcePath } from "~/utils/pathBuilder";
import {
  VercelSettingsPresenter,
  type VercelOnboardingData,
} from "~/presenters/v3/VercelSettingsPresenter.server";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import {
  type VercelProjectIntegrationData,
  type SyncEnvVarsMapping,
  type EnvSlug,
  envSlugArrayField,
  envTypeToSlug,
  getAvailableEnvSlugs,
  getAvailableEnvSlugsForBuildSettings,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { Result, fromPromise } from "neverthrow";
import { useEffect, useState } from "react";

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

const UpdateVercelConfigFormSchema = z.object({
  action: z.literal("update-config"),
  atomicBuilds: envSlugArrayField,
  pullEnvVarsBeforeBuild: envSlugArrayField,
  discoverEnvVars: envSlugArrayField,
  vercelStagingEnvironment: z.string().nullable().optional(),
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
  skipRedirect: z.string().optional().transform((val) => val === "true"),
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

  return typedjson({
    ...result,
    authInvalid,
    onboardingData,
    organizationSlug,
    projectSlug: projectParam,
    environmentSlug: envParam,
    projectId: project.id,
    organizationId: project.organizationId,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
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

  const formData = await request.formData();
  const submission = parse(formData, { schema: VercelActionSchema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  const settingsPath = v3ProjectSettingsPath(
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
      } = submission.value;

      const parsedStagingEnv = parseVercelStagingEnvironment(vercelStagingEnvironment);

      const result = await vercelService.updateVercelIntegrationConfig(project.id, {
        atomicBuilds,
        pullEnvVarsBeforeBuild,
        discoverEnvVars,
        vercelStagingEnvironment: parsedStagingEnv,
      });

      if (result) {
        return redirectWithSuccessMessage(settingsPath, request, "Vercel settings updated successfully");
      }

      return redirectWithErrorMessage(settingsPath, request, "Failed to update Vercel settings");
    }

    case "disconnect": {
      const success = await vercelService.disconnectVercelProject(project.id);

      if (success) {
        return redirectWithSuccessMessage(settingsPath, request, "Vercel project disconnected");
      }

      return redirectWithErrorMessage(settingsPath, request, "Failed to disconnect Vercel project");
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
      } = submission.value;

      const parsedStagingEnv = parseVercelStagingEnvironment(vercelStagingEnvironment);
      const parsedSyncEnvVarsMapping = syncEnvVarsMapping
        ? safeJsonParse(syncEnvVarsMapping).unwrapOr(undefined) as SyncEnvVarsMapping | undefined
        : undefined;

      const result = await vercelService.completeOnboarding(project.id, {
        vercelStagingEnvironment: parsedStagingEnv,
        pullEnvVarsBeforeBuild,
        atomicBuilds,
        discoverEnvVars,
        syncEnvVarsMapping: parsedSyncEnvVarsMapping,
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
        return json({ success: true });
      }

      return json({ success: false, error: "Failed to update environment mapping" }, { status: 400 });
    }

    case "skip-onboarding": {
      return redirectWithSuccessMessage(settingsPath, request, "Vercel integration setup skipped");
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

      const disableResult = await VercelIntegrationRepository.getVercelClient(orgIntegration)
        .andThen((client) =>
          VercelIntegrationRepository.disableAutoAssignCustomDomains(
            client,
            projectIntegration.parsedIntegrationData.vercelProjectId,
            teamId
          )
        );

      if (disableResult.isErr()) {
        logger.error("Failed to disable auto-assign custom domains", { error: disableResult.error });
        return redirectWithErrorMessage(settingsPath, request, "Failed to disable auto-assign custom domains");
      }

      return redirectWithSuccessMessage(settingsPath, request, "Auto-assign custom domains disabled");
    }

    default: {
      submission.value satisfies never;
      return redirectBackWithErrorMessage(request, "Failed to process request");
    }
  }
}

function VercelConnectionPrompt({
  organizationSlug,
  projectSlug,
  environmentSlug,
  hasOrgIntegration,
  isGitHubConnected,
  onOpenModal,
  isLoading,
}: {
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  hasOrgIntegration: boolean;
  isGitHubConnected: boolean;
  onOpenModal?: () => void;
  isLoading?: boolean;
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
                  disabled={isDisabled}
                  LeadingIcon={
                    isLoadingProjects
                      ? () => <SpinnerWhite className="size-4" />
                      : () => <VercelLogo className="size-4 -mx-1" />
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
                <LinkButton
                  to={installPath}
                  variant="secondary/medium"
                  LeadingIcon={() => <VercelLogo className="size-4 -mx-1" />}
                >
                  Install Vercel app
                </LinkButton>
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
}: { 
  organizationSlug: string;
  projectSlug: string;
}) {
  const installUrl = vercelAppInstallPath(organizationSlug, projectSlug);

  return (
    <Callout variant="error" className="mb-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <p className="font-sans text-sm font-medium text-text-bright mb-2">
            Vercel connection expired
          </p>
          <p className="font-sans text-xs text-text-dimmed mb-3">
            Your Vercel access token has expired or been revoked. Please reconnect to restore functionality.
          </p>
          <LinkButton
            to={installUrl}
            variant="minimal/small"
            className="bg-error/10 hover:bg-error/20 text-error border-error/20"
          >
            Reconnect Vercel
          </LinkButton>
        </div>
      </div>
    </Callout>
  );
}

function VercelGitHubWarning() {
  return (
    <Callout variant="warning" className="mb-4">
      <p className="font-sans text-xs font-normal text-text-dimmed">
        GitHub integration is not connected. Vercel integration cannot sync environment variables and
        link deployments without a properly installed GitHub integration.
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
  organizationSlug,
  projectSlug,
  environmentSlug,
}: {
  connectedProject: ConnectedVercelProject;
  hasStagingEnvironment: boolean;
  hasPreviewEnvironment: boolean;
  customEnvironments: Array<{ id: string; slug: string }>;
  autoAssignCustomDomains: boolean | null;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
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
  });

  const originalAtomicBuilds = connectedProject.integrationData.config.atomicBuilds ?? [];
  const originalPullEnvVars = connectedProject.integrationData.config.pullEnvVarsBeforeBuild ?? [];
  const originalDiscoverEnvVars = connectedProject.integrationData.config.discoverEnvVars ?? [];
  const originalStagingEnv = connectedProject.integrationData.config.vercelStagingEnvironment ?? null;

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
    const stagingEnvChanged = configValues.vercelStagingEnvironment?.environmentId !== originalStagingEnv?.environmentId;

    setHasConfigChanges(atomicBuildsChanged || pullEnvVarsChanged || discoverEnvVarsChanged || stagingEnvChanged);
  }, [configValues, originalAtomicBuilds, originalPullEnvVars, originalDiscoverEnvVars, originalStagingEnv]);

  const [configForm, fields] = useForm({
    id: "update-vercel-config",
    lastSubmission: lastSubmission,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: UpdateVercelConfigFormSchema,
      });
    },
  });

  const isConfigLoading =
    navigation.formData?.get("action") === "update-config" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const actionUrl = vercelResourcePath(organizationSlug, projectSlug, environmentSlug);

  const availableEnvSlugs = getAvailableEnvSlugs(hasStagingEnvironment, hasPreviewEnvironment);
  const availableEnvSlugsForBuildSettings = getAvailableEnvSlugsForBuildSettings(hasStagingEnvironment, hasPreviewEnvironment);

  const formatSelectedEnvs = (selected: EnvSlug[], availableSlugs: EnvSlug[] = availableEnvSlugs): string => {
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
            <Button variant="minimal/small">Disconnect</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>Disconnect Vercel project</DialogHeader>
            <div className="flex flex-col gap-3 pt-3">
              <Paragraph className="mb-1">
                Are you sure you want to disconnect{" "}
                <span className="font-semibold">{connectedProject.vercelProjectName}</span>?
                This will stop pulling environment variables and disable atomic deployments.
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
      <Form method="post" action={actionUrl} {...configForm.props}>
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
          value={configValues.vercelStagingEnvironment ? JSON.stringify(configValues.vercelStagingEnvironment) : ""}
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
                        setConfigValues((prev) => ({
                          ...prev,
                          vercelStagingEnvironment: env
                            ? { environmentId: env.id, displayName: env.slug }
                            : null,
                        }));
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
              />

              {/* Warning: autoAssignCustomDomains must be disabled for atomic deployments */}
              {autoAssignCustomDomains !== false &&
                configValues.atomicBuilds.includes("prod") && (
                  <Callout variant="warning">
                    <div className="flex flex-col gap-2">
                      <p className="font-sans text-xs font-normal text-text-dimmed">
                        Atomic deployments require the "Auto-assign Custom Domains" setting to be
                        disabled on your Vercel project. Without this, Vercel will promote
                        deployments before Trigger.dev is ready.
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

            <FormError>{configForm.error}</FormError>
          </InputGroup>

          <FormButtons
            confirmButton={
              <Button
                type="submit"
                name="action"
                value="update-config"
                variant="secondary/small"
                disabled={isConfigLoading || !hasConfigChanges}
                LeadingIcon={isConfigLoading ? SpinnerWhite : undefined}
              >
                Save
              </Button>
            }
          />
        </Fieldset>
      </Form>
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
  const location = useLocation();
  const data = fetcher.data;
  const [hasError, setHasError] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  useEffect(() => {
    if (!data?.authInvalid && !hasError && !data && !hasFetched) {
      fetcher.load(vercelResourcePath(organizationSlug, projectSlug, environmentSlug));
      setHasFetched(true);
    }
  }, [organizationSlug, projectSlug, environmentSlug, data?.authInvalid, hasError, data, hasFetched]);

  useEffect(() => {
    if (hasFetched && fetcher.state === "idle" && fetcher.data === undefined && !hasError) {
      setHasError(true);
    }
  }, [fetcher.state, fetcher.data, hasError, hasFetched]);

  if (hasError) {
    return (
      <div className="rounded-sm border border-rose-500/40 bg-rose-500/10 p-4">
        <div className="flex items-start gap-3">
          <ExclamationTriangleIcon className="h-5 w-5 text-rose-500 flex-shrink-0" />
          <div>
            <p className="font-medium text-rose-400">Failed to load Vercel settings</p>
            <p className="text-sm text-rose-300 mt-1">
              There was an error loading the Vercel integration settings. Please refresh the page to try again.
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
        {showAuthInvalid && <VercelAuthInvalidBanner organizationSlug={organizationSlug} projectSlug={projectSlug} />}
        {showGitHubWarning && <VercelGitHubWarning />}
        {!showAuthInvalid && (<ConnectedVercelProjectForm
          connectedProject={data.connectedProject}
          hasStagingEnvironment={data.hasStagingEnvironment}
          hasPreviewEnvironment={data.hasPreviewEnvironment}
          customEnvironments={data.customEnvironments}
          autoAssignCustomDomains={data.autoAssignCustomDomains ?? null}
          organizationSlug={organizationSlug}
          projectSlug={projectSlug}
          environmentSlug={environmentSlug}
        />)}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {showAuthInvalid && <VercelAuthInvalidBanner organizationSlug={organizationSlug} projectSlug={projectSlug} />}
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
          />
          <Hint>
            {data.hasOrgIntegration
              ? "Connect your Vercel project to pull environment variables and trigger builds automatically."
              : "Install the Vercel app to connect your projects and pull environment variables."}
          </Hint>
          {!data.isGitHubConnected && (
            <Hint>
              GitHub integration is not connected. Vercel integration cannot sync environment variables and
              link deployments without a properly installed GitHub integration.
            </Hint>
          )}
        </>
      )}
    </div>
  );
}


import { VercelOnboardingModal } from "~/components/integrations/VercelOnboardingModal";

export { VercelSettingsPanel, VercelOnboardingModal };
