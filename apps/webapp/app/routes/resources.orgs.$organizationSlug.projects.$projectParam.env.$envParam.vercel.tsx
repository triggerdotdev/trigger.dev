import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "@heroicons/react/20/solid";
import {
  Form,
  useActionData,
  useFetcher,
  useNavigation,
  useSearchParams,
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
import { Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import { TextLink } from "~/components/primitives/TextLink";
import { DateTime } from "~/components/primitives/DateTime";
import {
  redirectBackWithErrorMessage,
  redirectBackWithSuccessMessage,
  redirectWithSuccessMessage,
  redirectWithErrorMessage,
} from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3ProjectSettingsPath, vercelAppInstallPath } from "~/utils/pathBuilder";
import { cn } from "~/utils/cn";
import {
  VercelSettingsPresenter,
  type VercelSettingsResult,
  type VercelOnboardingData,
} from "~/presenters/v3/VercelSettingsPresenter.server";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import {
  type VercelProjectIntegrationData,
  type SyncEnvVarsMapping,
  shouldSyncEnvVarForAnyEnvironment,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { useEffect, useState, useCallback, useRef } from "react";

// ============================================================================
// Types
// ============================================================================

export type ConnectedVercelProject = {
  id: string;
  vercelProjectId: string;
  vercelProjectName: string;
  vercelTeamId: string | null;
  integrationData: VercelProjectIntegrationData;
  createdAt: Date;
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format Vercel target environments for display
 * e.g., ["production", "preview"] → "Production, Preview"
 */
function formatVercelTargets(targets: string[]): string {
  const targetLabels: Record<string, string> = {
    production: "Production",
    preview: "Preview",
    development: "Development",
  };

  return targets
    .map((t) => targetLabels[t] || t)
    .join(", ");
}

/**
 * Look up the name (slug) of a Vercel custom environment by its ID
 */
async function lookupVercelEnvironmentName(
  projectId: string,
  environmentId: string | null
): Promise<string | null> {
  if (!environmentId) {
    return null;
  }

  try {
    // Get the project integration
    const vercelService = new VercelIntegrationService();
    const projectIntegration = await vercelService.getVercelProjectIntegration(projectId);
    if (!projectIntegration) {
      return null;
    }

    // Get the org integration
    const orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationForProject(projectId);
    if (!orgIntegration) {
      return null;
    }

    // Get the Vercel client
    const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);
    const client = await VercelIntegrationRepository.getVercelClient(orgIntegration);

    // Fetch custom environments
    const customEnvironments = await VercelIntegrationRepository.getVercelCustomEnvironments(
      client,
      projectIntegration.parsedIntegrationData.vercelProjectId,
      teamId
    );

    // Look up the name from the ID
    const environment = customEnvironments.find((env) => env.id === environmentId);
    return environment?.slug || null;
  } catch (error) {
    logger.error("Failed to look up Vercel environment name", {
      projectId,
      environmentId,
      error,
    });
    return null;
  }
}

// ============================================================================
// Schemas
// ============================================================================

const UpdateVercelConfigFormSchema = z.object({
  action: z.literal("update-config"),
  pullEnvVarsFromVercel: z
    .string()
    .optional()
    .transform((val) => val === "on"),
  spawnDeploymentOnVercelEvent: z
    .string()
    .optional()
    .transform((val) => val === "on"),
  spawnBuildOnVercelEvent: z
    .string()
    .optional()
    .transform((val) => val === "on"),
  vercelStagingEnvironment: z.string().nullable().optional(),
  vercelStagingName: z.string().nullable().optional(),
});

const DisconnectVercelFormSchema = z.object({
  action: z.literal("disconnect"),
});

const CompleteOnboardingFormSchema = z.object({
  action: z.literal("complete-onboarding"),
  vercelStagingEnvironment: z.string().nullable().optional(),
  vercelStagingName: z.string().nullable().optional(),
  pullEnvVarsFromVercel: z
    .string()
    .optional()
    .transform((val) => val === "on"),
  syncEnvVarsMapping: z.string().optional(), // JSON-encoded mapping
  next: z.string().optional(),
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
  vercelStagingName: z.string().nullable().optional(),
});

const VercelActionSchema = z.discriminatedUnion("action", [
  UpdateVercelConfigFormSchema,
  DisconnectVercelFormSchema,
  CompleteOnboardingFormSchema,
  SkipOnboardingFormSchema,
  SelectVercelProjectFormSchema,
  UpdateEnvMappingFormSchema,
]);

// ============================================================================
// Loader
// ============================================================================

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
    throw new Response("Failed to load Vercel settings", { status: 500 });
  }

  // Check if we need onboarding data
  const url = new URL(request.url);
  const needsOnboarding = url.searchParams.get("vercelOnboarding") === "true";

  let onboardingData: VercelOnboardingData | null = null;
  if (needsOnboarding) {
    // Always fetch onboarding data when in onboarding mode, even if no project selected yet
    // This allows us to show the project selection step
    onboardingData = await presenter.getOnboardingData(project.id, project.organizationId);
  }

  return typedjson({
    ...resultOrFail.value,
    onboardingData,
    organizationSlug,
    projectSlug: projectParam,
    environmentSlug: envParam,
    projectId: project.id,
    organizationId: project.organizationId,
  });
}

// ============================================================================
// Action
// ============================================================================

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

  const vercelService = new VercelIntegrationService();
  const { action: actionType } = submission.value;

  // Handle update-config action
  if (actionType === "update-config") {
    const {
      pullEnvVarsFromVercel,
      spawnDeploymentOnVercelEvent,
      spawnBuildOnVercelEvent,
      vercelStagingEnvironment,
      vercelStagingName,
    } = submission.value;

    // If vercelStagingName is not provided, look it up from the environment ID
    let stagingName = vercelStagingName ?? null;
    if (vercelStagingEnvironment && !stagingName) {
      stagingName = await lookupVercelEnvironmentName(project.id, vercelStagingEnvironment);
    }

    const result = await vercelService.updateVercelIntegrationConfig(project.id, {
      pullEnvVarsFromVercel,
      spawnDeploymentOnVercelEvent,
      spawnBuildOnVercelEvent,
      vercelStagingEnvironment: vercelStagingEnvironment ?? null,
      vercelStagingName: stagingName,
    });

    const settingsPath = v3ProjectSettingsPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    );

    if (result) {
      return redirectWithSuccessMessage(settingsPath, request, "Vercel settings updated successfully");
    }

    return redirectWithErrorMessage(settingsPath, request, "Failed to update Vercel settings");
  }

  // Handle disconnect action
  if (actionType === "disconnect") {
    const success = await vercelService.disconnectVercelProject(project.id);

    const settingsPath = v3ProjectSettingsPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    );

    if (success) {
      return redirectWithSuccessMessage(settingsPath, request, "Vercel project disconnected");
    }

    return redirectWithErrorMessage(settingsPath, request, "Failed to disconnect Vercel project");
  }

  // Handle complete-onboarding action
  if (actionType === "complete-onboarding") {
    const {
      vercelStagingEnvironment,
      vercelStagingName,
      pullEnvVarsFromVercel,
      syncEnvVarsMapping,
      next,
    } = submission.value;

    let parsedMapping: SyncEnvVarsMapping = {};
    if (syncEnvVarsMapping) {
      try {
        parsedMapping = JSON.parse(syncEnvVarsMapping) as SyncEnvVarsMapping;
      } catch (e) {
        logger.error("Failed to parse syncEnvVarsMapping", { error: e });
      }
    }

    // If vercelStagingName is not provided, look it up from the environment ID
    let stagingName = vercelStagingName ?? null;
    if (vercelStagingEnvironment && !stagingName) {
      stagingName = await lookupVercelEnvironmentName(project.id, vercelStagingEnvironment);
    }

    const result = await vercelService.completeOnboarding(project.id, {
      vercelStagingEnvironment: vercelStagingEnvironment ?? null,
      vercelStagingName: stagingName,
      pullEnvVarsFromVercel: pullEnvVarsFromVercel ?? true,
      syncEnvVarsMapping: parsedMapping,
    });

    if (result) {
      // Check if we should redirect to the 'next' URL
      if (next) {
        try {
          // Validate that next is a valid URL
          const nextUrl = new URL(next);
          // Only allow https URLs for security
          if (nextUrl.protocol === "https:") {
            // Return JSON with redirect URL for fetcher to handle
            return json({ success: true, redirectTo: next });
          }
        } catch (e) {
          // Invalid URL, fall through to default redirect
          logger.warn("Invalid next URL provided", { next, error: e });
        }
      }

      // Default redirect to settings page without the vercelOnboarding param to close the modal
      const settingsPath = v3ProjectSettingsPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam }
      );
      // Return JSON with redirect URL for fetcher to handle
      return json({ success: true, redirectTo: settingsPath });
    }

    const settingsPath = v3ProjectSettingsPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    );
    return redirectWithErrorMessage(settingsPath, request, "Failed to complete Vercel setup");
  }

  // Handle update-env-mapping action (during onboarding)
  if (actionType === "update-env-mapping") {
    const { vercelStagingEnvironment, vercelStagingName } = submission.value;

    // If vercelStagingName is not provided, look it up from the environment ID
    let stagingName = vercelStagingName ?? null;
    if (vercelStagingEnvironment && !stagingName) {
      stagingName = await lookupVercelEnvironmentName(project.id, vercelStagingEnvironment);
    }

    const result = await vercelService.updateVercelIntegrationConfig(project.id, {
      vercelStagingEnvironment: vercelStagingEnvironment ?? null,
      vercelStagingName: stagingName,
    });

    if (result) {
      return json({ success: true });
    }

    return json({ success: false, error: "Failed to update environment mapping" }, { status: 400 });
  }

  // Handle skip-onboarding action
  if (actionType === "skip-onboarding") {
    const settingsPath = v3ProjectSettingsPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    );
    return redirectWithSuccessMessage(settingsPath, request, "Vercel integration setup skipped");
  }

  // Handle select-vercel-project action
  if (actionType === "select-vercel-project") {
    const { vercelProjectId, vercelProjectName } = submission.value;

    try {
      const { integration, syncResult } = await vercelService.selectVercelProject({
        organizationId: project.organizationId,
        projectId: project.id,
        vercelProjectId,
        vercelProjectName,
        userId,
      });

      if (!syncResult.success && syncResult.errors.length > 0) {
        logger.warn("Failed to send trigger secrets to Vercel", {
          projectId: project.id,
          vercelProjectId,
          errors: syncResult.errors,
        });
        // Still proceed - user can manually configure API keys
      }

      // Return success to allow the onboarding flow to continue
      return json({
        success: true,
        integrationId: integration.id,
        syncErrors: syncResult.errors,
      });
    } catch (error) {
      logger.error("Failed to select Vercel project", { error });
      return json({
        error: "Failed to connect Vercel project. Please try again.",
      });
    }
  }

  submission.value satisfies never;
  return redirectBackWithErrorMessage(request, "Failed to process request");
}

// ============================================================================
// Helper: Build resource URL for fetching Vercel data
// ============================================================================

export function vercelResourcePath(
  organizationSlug: string,
  projectSlug: string,
  environmentSlug: string
) {
  return `/resources/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/vercel`;
}

// ============================================================================
// Vercel Icon Component
// ============================================================================

function VercelIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 76 65"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
    </svg>
  );
}

// ============================================================================
// Components
// ============================================================================

/**
 * Prompt to connect Vercel integration
 */
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
  // Generate the install path
  const installPath = vercelAppInstallPath(organizationSlug, projectSlug);

  // Handle connecting project when org integration exists
  const handleConnectProject = () => {
    // Just trigger the callback - the parent will handle loading and opening
    if (onOpenModal) {
      onOpenModal();
    }
  };

  const isLoadingProjects = isLoading ?? false;

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
                  disabled={isLoadingProjects}
                  LeadingIcon={
                    isLoadingProjects
                      ? () => <SpinnerWhite className="size-4" />
                      : () => <VercelIcon className="size-4 -mx-1" />
                  }
                >
                  {isLoadingProjects ? "Loading projects..." : "Connect Vercel project"}
                </Button>
                <span className="flex items-center gap-1 text-xs text-text-dimmed">
                  <CheckCircleIcon className="size-4 text-success" /> Vercel app is installed
                </span>
              </>
            ) : (
              <>
                <LinkButton
                  to={installPath}
                  variant="secondary/medium"
                  LeadingIcon={() => <VercelIcon className="size-4 -mx-1" />}
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

/**
 * Warning banner when Vercel is connected but GitHub is not
 */
function VercelGitHubWarning() {
  return (
    <Callout variant="warning" className="mb-4">
      <p className="font-sans text-xs font-normal text-text-dimmed">
        GitHub integration is not connected. Vercel integration cannot sync environment variables or
        spawn Trigger.dev builds without a properly installed GitHub integration.
      </p>
    </Callout>
  );
}

/**
 * Connected Vercel project settings form
 */
function ConnectedVercelProjectForm({
  connectedProject,
  hasStagingEnvironment,
  customEnvironments,
  organizationSlug,
  projectSlug,
  environmentSlug,
}: {
  connectedProject: ConnectedVercelProject;
  hasStagingEnvironment: boolean;
  customEnvironments?: Array<{ id: string; slug: string }>;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
}) {
  const lastSubmission = useActionData() as any;
  const navigation = useNavigation();

  const [hasConfigChanges, setHasConfigChanges] = useState(false);
  const [configValues, setConfigValues] = useState({
    pullEnvVarsFromVercel: connectedProject.integrationData.config.pullEnvVarsFromVercel,
    spawnDeploymentOnVercelEvent:
      connectedProject.integrationData.config.spawnDeploymentOnVercelEvent,
    spawnBuildOnVercelEvent: connectedProject.integrationData.config.spawnBuildOnVercelEvent,
    vercelStagingEnvironment:
      connectedProject.integrationData.config.vercelStagingEnvironment || "",
    vercelStagingName: connectedProject.integrationData.config.vercelStagingName || null,
  });

  useEffect(() => {
    const hasChanges =
      configValues.pullEnvVarsFromVercel !==
        connectedProject.integrationData.config.pullEnvVarsFromVercel ||
      configValues.spawnDeploymentOnVercelEvent !==
        connectedProject.integrationData.config.spawnDeploymentOnVercelEvent ||
      configValues.spawnBuildOnVercelEvent !==
        connectedProject.integrationData.config.spawnBuildOnVercelEvent ||
      configValues.vercelStagingEnvironment !==
        (connectedProject.integrationData.config.vercelStagingEnvironment || "") ||
      configValues.vercelStagingName !==
        (connectedProject.integrationData.config.vercelStagingName || null);
    setHasConfigChanges(hasChanges);
  }, [configValues, connectedProject.integrationData.config]);

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

  return (
    <>
      {/* Connected project info */}
      <div className="mb-4 flex items-center justify-between rounded-sm border bg-grid-dimmed p-2">
        <div className="flex items-center gap-2">
          <VercelIcon className="size-4" />
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
                This will stop syncing environment variables and disable Vercel-triggered builds.
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
        <Fieldset>
          <InputGroup fullWidth>
            <div className="flex flex-col gap-4">
              {/* Staging environment mapping info */}
              {hasStagingEnvironment &&
                connectedProject.integrationData.config.vercelStagingEnvironment &&
                connectedProject.integrationData.config.vercelStagingEnvironment !== "" &&
                connectedProject.integrationData.config.vercelStagingName && (
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Staging environment mapping</Label>
                      <Hint>
                        Vercel environment mapped to Trigger.dev's Staging environment.
                      </Hint>
                    </div>
                    <span className="font-mono text-sm text-text-bright">
                      {connectedProject.integrationData.config.vercelStagingName}
                    </span>
                  </div>
                )}

              {/* Pull env vars toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <Label>Sync environment variables from Vercel</Label>
                  <Hint>
                    When enabled, environment variables will be pulled from Vercel during builds.
                    Configure which variables to sync on the{" "}
                    <TextLink to={`/orgs/${organizationSlug}/projects/${projectSlug}/environment-variables`}>
                      environment variables page
                    </TextLink>
                    .
                  </Hint>
                </div>
                <Switch
                  name="pullEnvVarsFromVercel"
                  variant="small"
                  defaultChecked={connectedProject.integrationData.config.pullEnvVarsFromVercel}
                  onCheckedChange={(checked) => {
                    setConfigValues((prev) => ({
                      ...prev,
                      pullEnvVarsFromVercel: checked,
                    }));
                  }}
                />
              </div>

              {/* Spawn deployment toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <Label>Spawn deployment on Vercel deployment</Label>
                  <Hint>
                    When enabled, a Trigger.dev deployment will be created when Vercel deploys.
                  </Hint>
                </div>
                <Switch
                  name="spawnDeploymentOnVercelEvent"
                  variant="small"
                  defaultChecked={
                    connectedProject.integrationData.config.spawnDeploymentOnVercelEvent
                  }
                  onCheckedChange={(checked) => {
                    setConfigValues((prev) => ({
                      ...prev,
                      spawnDeploymentOnVercelEvent: checked,
                    }));
                  }}
                />
              </div>

              {/* Spawn build toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <Label>Spawn build on Vercel build</Label>
                  <Hint>
                    When enabled, a Trigger.dev build will be triggered when Vercel builds.
                  </Hint>
                </div>
                <Switch
                  name="spawnBuildOnVercelEvent"
                  variant="small"
                  defaultChecked={connectedProject.integrationData.config.spawnBuildOnVercelEvent}
                  onCheckedChange={(checked) => {
                    setConfigValues((prev) => ({
                      ...prev,
                      spawnBuildOnVercelEvent: checked,
                    }));
                  }}
                />
              </div>

              {/* Staging environment mapping */}
              {hasStagingEnvironment && customEnvironments && customEnvironments.length > 0 && (
                <div>
                  <Label>Map Vercel environment to Staging</Label>
                  <Hint className="mb-2">
                    Select which custom Vercel environment should map to Trigger.dev's Staging
                    environment.
                  </Hint>
                  <Select
                    name="vercelStagingEnvironment"
                    value={configValues.vercelStagingEnvironment}
                    setValue={(value) => {
                      if (!Array.isArray(value)) {
                        const environment = customEnvironments.find((e) => e.id === value);
                        setConfigValues((prev) => ({
                          ...prev,
                          vercelStagingEnvironment: value,
                          vercelStagingName: environment?.slug || null,
                        }));
                      }
                    }}
                    items={[{ id: "", slug: "None" }, ...customEnvironments]}
                    variant="tertiary/small"
                    placeholder="Select environment"
                    dropdownIcon
                    text={
                      configValues.vercelStagingEnvironment
                        ? customEnvironments.find(
                            (e) => e.id === configValues.vercelStagingEnvironment
                          )?.slug || "None"
                        : "None"
                    }
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
                  {configValues.vercelStagingName && (
                    <input
                      type="hidden"
                      name="vercelStagingName"
                      value={configValues.vercelStagingName}
                    />
                  )}
                </div>
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

// ============================================================================
// Main Vercel Settings Panel Component
// ============================================================================

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

  useEffect(() => {
    fetcher.load(vercelResourcePath(organizationSlug, projectSlug, environmentSlug));
  }, [organizationSlug, projectSlug, environmentSlug]);

  const data = fetcher.data;

  // Loading state
  if (fetcher.state === "loading" && !data) {
    return (
      <div className="flex items-center gap-2 text-text-dimmed">
        <SpinnerWhite className="size-4" />
        <span className="text-sm">Loading Vercel settings...</span>
      </div>
    );
  }

  // Vercel integration not enabled
  if (!data || !data.enabled) {
    return null;
  }

  // Show warning if Vercel connected but GitHub not
  const showGitHubWarning = data.connectedProject && !data.isGitHubConnected;

  // Connected project exists - show form
  if (data.connectedProject) {
    return (
      <>
        {showGitHubWarning && <VercelGitHubWarning />}
        <ConnectedVercelProjectForm
          connectedProject={data.connectedProject}
          hasStagingEnvironment={data.hasStagingEnvironment}
          customEnvironments={data.onboardingData?.customEnvironments}
          organizationSlug={organizationSlug}
          projectSlug={projectSlug}
          environmentSlug={environmentSlug}
        />
      </>
    );
  }

  // No connected project - show connection prompt
  // If org integration exists, show "app installed" message; otherwise show install button
  return (
    <div className="flex flex-col gap-2">
      <VercelConnectionPrompt
        organizationSlug={organizationSlug}
        projectSlug={projectSlug}
        environmentSlug={environmentSlug}
        hasOrgIntegration={data.hasOrgIntegration}
        isGitHubConnected={data.isGitHubConnected}
        onOpenModal={onOpenVercelModal}
        isLoading={isLoadingVercelData}
      />
      <Hint>
        {data.hasOrgIntegration
          ? "Connect your Vercel project to sync environment variables and trigger builds automatically."
          : "Install the Vercel app to connect your projects and sync environment variables."}
      </Hint>
      {!data.isGitHubConnected && (
        <Hint>
          GitHub integration is not connected. Vercel integration cannot sync environment variables or
          spawn Trigger.dev builds without a properly installed GitHub integration.
        </Hint>
      )}
    </div>
  );
}

// ============================================================================
// Onboarding Modal Component
// ============================================================================

type OnboardingState =
  | "idle" // Initial state
  | "installing" // Redirecting to Vercel installation (transient)
  | "loading-projects" // Loading Vercel projects list
  | "project-selection" // Showing project selection UI
  | "loading-env-mapping" // After project selection, checking for custom envs
  | "env-mapping" // Showing custom environment mapping UI
  | "loading-env-vars" // Loading environment variables
  | "env-var-sync" // Showing environment variable sync UI
  | "completed"; // Onboarding complete (closes modal)

function VercelOnboardingModal({
  isOpen,
  onClose,
  onboardingData,
  organizationSlug,
  projectSlug,
  environmentSlug,
  hasStagingEnvironment,
  hasOrgIntegration,
  nextUrl,
  onDataReload,
}: {
  isOpen: boolean;
  onClose: () => void;
  onboardingData: VercelOnboardingData | null;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  hasStagingEnvironment: boolean;
  hasOrgIntegration: boolean;
  nextUrl?: string;
  onDataReload?: () => void;
}) {
  const navigation = useNavigation();
  const fetcher = useTypedFetcher<typeof loader>();
  const envMappingFetcher = useFetcher();
  const completeOnboardingFetcher = useFetcher();
  const { Form: CompleteOnboardingForm } = completeOnboardingFetcher;

  const availableProjects = onboardingData?.availableProjects || [];
  const hasProjectSelected = onboardingData?.hasProjectSelected ?? false;
  const customEnvironments = onboardingData?.customEnvironments || [];
  const envVars = onboardingData?.environmentVariables || [];
  const hasCustomEnvs = customEnvironments.length > 0 && hasStagingEnvironment;

  // Compute initial state based on current data
  const computeInitialState = useCallback((): OnboardingState => {
    // If no org integration, stay in idle (shouldn't happen as modal only opens with integration)
    if (!hasOrgIntegration) {
      return "idle";
    }
    // If no project selected, check if we need to load projects
    const projectSelected = onboardingData?.hasProjectSelected ?? false;
    if (!projectSelected) {
      if (!onboardingData?.availableProjects || onboardingData.availableProjects.length === 0) {
        return "loading-projects";
      }
      return "project-selection";
    }
    // Project selected, check for custom environments
    const customEnvs = (onboardingData?.customEnvironments?.length ?? 0) > 0 && hasStagingEnvironment;
    if (customEnvs) {
      return "env-mapping";
    }
    // No custom envs, check if env vars are loaded
    if (!onboardingData?.environmentVariables || onboardingData.environmentVariables.length === 0) {
      return "loading-env-vars";
    }
    return "env-var-sync";
  }, [hasOrgIntegration, onboardingData, hasStagingEnvironment]);

  // Initialize state based on current data when modal opens
  const [state, setState] = useState<OnboardingState>(() => {
    if (!isOpen) return "idle";
    return computeInitialState();
  });

  // Update state when modal opens or data changes
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      // Modal just opened, compute initial state
      setState(computeInitialState());
    } else if (isOpen && state === "idle") {
      // Modal is open but in idle state, compute initial state
      setState(computeInitialState());
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, state, computeInitialState]);

  const [selectedVercelProject, setSelectedVercelProject] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [vercelStagingEnvironment, setVercelStagingEnvironment] = useState<string>("");
  const [pullEnvVarsFromVercel, setPullEnvVarsFromVercel] = useState(true);
  const [syncEnvVarsMapping, setSyncEnvVarsMapping] = useState<SyncEnvVarsMapping>({});
  const [expandedEnvVars, setExpandedEnvVars] = useState(false);
  const [projectSelectionError, setProjectSelectionError] = useState<string | null>(null);

  // State machine processor: handles state transitions based on current state and available data
  // Note: "idle" state is only when modal is closed, so we don't process it here
  useEffect(() => {
    if (!isOpen || state === "idle") {
      return; // Don't process when modal is closed or in idle state
    }

    switch (state) {

      case "loading-projects":
        // Trigger data reload to fetch projects
        if (onDataReload) {
          onDataReload();
        }
        // Transition will happen when data loads (handled by another effect)
        break;

      case "loading-env-mapping":
        // After project selection, reload data to get custom environments
        if (onDataReload) {
          onDataReload();
        }
        // Transition handled by button click success
        break;

      case "loading-env-vars":
        // Reload data to get environment variables
        if (onDataReload) {
          onDataReload();
        }
        // Transition to env-var-sync when data is ready (handled by another effect)
        break;

      // Other states don't need processing
      case "installing":
      case "project-selection":
      case "env-mapping":
      case "env-var-sync":
      case "completed":
        break;
    }
  }, [isOpen, state, hasOrgIntegration, hasProjectSelected, onboardingData, hasCustomEnvs, hasStagingEnvironment, onDataReload]);

  // Watch for data loading completion
  useEffect(() => {
    if (state === "loading-projects" && onboardingData?.availableProjects && onboardingData.availableProjects.length > 0) {
      // Projects loaded, transition to project selection
      setState("project-selection");
    }
  }, [state, onboardingData?.availableProjects]);

  useEffect(() => {
    if (state === "loading-env-vars" && onboardingData?.environmentVariables) {
      // Environment variables loaded, transition to env-var-sync
      setState("env-var-sync");
    }
  }, [state, onboardingData?.environmentVariables]);

  // Handle successful project selection - transition to loading-env-mapping
  useEffect(() => {
    if (state === "project-selection" && fetcher.data && "success" in fetcher.data && fetcher.data.success && fetcher.state === "idle") {
      // Project selection succeeded, transition to loading-env-mapping
      setState("loading-env-mapping");
      // Reload data to get updated project info and env vars
      if (onDataReload) {
        onDataReload();
      }
    } else if (fetcher.data && "error" in fetcher.data && typeof fetcher.data.error === "string") {
      setProjectSelectionError(fetcher.data.error);
    }
  }, [state, fetcher.data, fetcher.state, onDataReload]);

  // Handle loading-env-mapping completion - check for custom environments
  useEffect(() => {
    if (state === "loading-env-mapping" && onboardingData) {
      const hasCustomEnvs = (onboardingData.customEnvironments?.length ?? 0) > 0 && hasStagingEnvironment;
      if (hasCustomEnvs) {
        setState("env-mapping");
      } else {
        // No custom envs, load env vars
        setState("loading-env-vars");
      }
    }
  }, [state, onboardingData, hasStagingEnvironment]);

  // Calculate env var stats
  const secretEnvVars = envVars.filter((v) => v.isSecret);
  const syncableEnvVars = envVars.filter((v) => !v.isSecret);
  const enabledEnvVars = syncableEnvVars.filter(
    (v) => shouldSyncEnvVarForAnyEnvironment(syncEnvVarsMapping, v.key)
  );

  const isSubmitting =
    navigation.state === "submitting" || navigation.state === "loading";

  const actionUrl = vercelResourcePath(organizationSlug, projectSlug, environmentSlug);

  const handleToggleEnvVar = useCallback((key: string, enabled: boolean) => {
    setSyncEnvVarsMapping((prev) => {
      if (enabled) {
        // Remove from mapping (default is enabled for all environments)
        const { [key]: _, ...rest } = prev;
        return rest;
      }
      // Disable for all environments
      return {
        ...prev,
        [key]: {
          PRODUCTION: false,
          STAGING: false,
          PREVIEW: false,
          DEVELOPMENT: false,
        },
      };
    });
  }, []);

  const handleToggleAll = useCallback(
    (enabled: boolean) => {
      setPullEnvVarsFromVercel(enabled);
      if (enabled) {
        // Reset all mappings (default to sync all)
        setSyncEnvVarsMapping({});
      }
    },
    []
  );

  // Handle project selection submission - explicit state transition
  const handleProjectSelection = useCallback(async () => {
    if (!selectedVercelProject) {
      setProjectSelectionError("Please select a Vercel project");
      return;
    }

    setProjectSelectionError(null);

    // Submit the form programmatically using fetcher
    const formData = new FormData();
    formData.append("action", "select-vercel-project");
    formData.append("vercelProjectId", selectedVercelProject.id);
    formData.append("vercelProjectName", selectedVercelProject.name);

    fetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });
    // State transition to loading-env-mapping will happen in useEffect when success
  }, [selectedVercelProject, fetcher, actionUrl]);


  // Handle skip onboarding submission - close modal immediately and submit in background
  const handleSkipOnboarding = useCallback(() => {
    // Close modal immediately
    onClose();

    // Submit in background (non-blocking)
    const formData = new FormData();
    formData.append("action", "skip-onboarding");
    fetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });
  }, [actionUrl, fetcher, onClose]);

  // Handle environment mapping update - explicit state transition
  const handleUpdateEnvMapping = useCallback(() => {
    const formData = new FormData();
    formData.append("action", "update-env-mapping");
    if (vercelStagingEnvironment) {
      formData.append("vercelStagingEnvironment", vercelStagingEnvironment);
      // Look up the name from customEnvironments
      const environment = customEnvironments.find((env) => env.id === vercelStagingEnvironment);
      if (environment) {
        formData.append("vercelStagingName", environment.slug);
      }
    }
    envMappingFetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });
    // State transition to loading-env-vars will happen in useEffect when success
  }, [vercelStagingEnvironment, customEnvironments, envMappingFetcher, actionUrl]);

  // Handle Finish button - submit form via fetcher
  const handleFinishOnboarding = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    completeOnboardingFetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });
  }, [completeOnboardingFetcher, actionUrl]);

  // Handle successful onboarding completion
  useEffect(() => {
    if (completeOnboardingFetcher.data && typeof completeOnboardingFetcher.data === "object" && "success" in completeOnboardingFetcher.data && completeOnboardingFetcher.data.success && completeOnboardingFetcher.state === "idle") {
      // Check if we need to redirect to a specific URL
      if ("redirectTo" in completeOnboardingFetcher.data && typeof completeOnboardingFetcher.data.redirectTo === "string") {
        // Navigate to the redirect URL (handles both internal and external URLs)
        window.location.href = completeOnboardingFetcher.data.redirectTo;
        return;
      }
      // No redirect, just close the modal
      setState("completed");
    }
  }, [completeOnboardingFetcher.data, completeOnboardingFetcher.state]);

  // Handle completed state - close modal
  useEffect(() => {
    if (state === "completed") {
      onClose();
    }
  }, [state, onClose]);

  // Handle installation redirect
  useEffect(() => {
    if (state === "installing") {
      const installUrl = vercelAppInstallPath(organizationSlug, projectSlug);
      window.location.href = installUrl; // Same window redirect
    }
  }, [state, organizationSlug, projectSlug]);

  // Handle successful env mapping update
  useEffect(() => {
    if (envMappingFetcher.data && typeof envMappingFetcher.data === "object" && "success" in envMappingFetcher.data && envMappingFetcher.data.success && envMappingFetcher.state === "idle") {
      setState("loading-env-vars");
    }
  }, [envMappingFetcher.data, envMappingFetcher.state]);

  // Don't render if modal is closed
  if (!isOpen) {
    return null;
  }

  // Show loading state for loading states or if data is not ready yet
  // Note: "idle" is only when modal is closed, so we don't show loading for it
  const isLoadingState =
    state === "loading-projects" ||
    state === "loading-env-mapping" ||
    state === "loading-env-vars" ||
    state === "installing" ||
    (state === "idle" && !onboardingData);

  if (isLoadingState) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <VercelIcon className="size-5" />
              <span>Set up Vercel Integration</span>
            </div>
          </DialogHeader>
          <div className="flex items-center justify-center py-8">
            <SpinnerWhite className="size-6" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Determine which step content to show based on state machine
  const showProjectSelection = state === "project-selection";
  const showEnvMapping = state === "env-mapping";
  const showEnvVarSync = state === "env-var-sync";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <VercelIcon className="size-5" />
            <span>Set up Vercel Integration</span>
          </div>
        </DialogHeader>

        <div className="mt-4">
          {/* Step: Project Selection (only if no project selected) */}
          {showProjectSelection && (
            <div className="flex flex-col gap-4">
              <Header3>Select Vercel Project</Header3>
              <Paragraph className="text-sm">
                Choose which Vercel project to connect with this Trigger.dev project.
                Your API keys will be automatically synced to Vercel.
              </Paragraph>

              {availableProjects.length === 0 ? (
                <Callout variant="warning">
                  No Vercel projects found. Please create a project in Vercel first.
                </Callout>
              ) : (
                <Select
                  value={selectedVercelProject?.id || ""}
                  setValue={(value) => {
                    if (!Array.isArray(value)) {
                      const project = availableProjects.find((p) => p.id === value);
                      setSelectedVercelProject(project || null);
                      setProjectSelectionError(null);
                    }
                  }}
                  items={availableProjects}
                  variant="tertiary/medium"
                  placeholder="Select a Vercel project"
                  dropdownIcon
                  text={selectedVercelProject?.name || "Select a project"}
                >
                  {availableProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </Select>
              )}

              {projectSelectionError && (
                <FormError>{projectSelectionError}</FormError>
              )}

              <Hint>
                Once connected, your <code className="text-xs">TRIGGER_SECRET_KEY</code> will be 
                automatically synced to Vercel for each environment.
              </Hint>

              <FormButtons
                confirmButton={
                  <Button
                    variant="primary/medium"
                    onClick={handleProjectSelection}
                    disabled={!selectedVercelProject || fetcher.state !== "idle"}
                    LeadingIcon={fetcher.state !== "idle" ? SpinnerWhite : undefined}
                  >
                    {fetcher.state !== "idle" ? "Connecting..." : "Connect Project"}
                  </Button>
                }
                cancelButton={
                  <Button
                    variant="tertiary/medium"
                    onClick={handleSkipOnboarding}
                  >
                    Cancel
                  </Button>
                }
              />
            </div>
          )}

          {/* Step: Environment Mapping (only if custom environments exist) */}
          {showEnvMapping && (
            <div className="flex flex-col gap-4">
              <Header3>Map Vercel Environment to Staging</Header3>
              <Paragraph className="text-sm">
                Select which custom Vercel environment should map to Trigger.dev's Staging
                environment. Production and Preview environments are mapped automatically.
              </Paragraph>

              <Select
                value={vercelStagingEnvironment}
                setValue={(value) => {
                  if (!Array.isArray(value)) {
                    setVercelStagingEnvironment(value);
                  }
                }}
                items={[{ id: "", slug: "None (skip)" }, ...customEnvironments]}
                variant="tertiary/medium"
                placeholder="Select environment"
                dropdownIcon
                text={
                  vercelStagingEnvironment
                    ? customEnvironments.find((e) => e.id === vercelStagingEnvironment)?.slug ||
                      "None"
                    : "None (skip)"
                }
              >
                {[
                  <SelectItem key="" value="">
                    None (skip)
                  </SelectItem>,
                  ...customEnvironments.map((env) => (
                    <SelectItem key={env.id} value={env.id}>
                      {env.slug}
                    </SelectItem>
                  )),
                ]}
              </Select>

              <FormButtons
                confirmButton={
                  <Button
                    variant="primary/medium"
                    onClick={handleUpdateEnvMapping}
                    disabled={envMappingFetcher.state !== "idle"}
                    LeadingIcon={envMappingFetcher.state !== "idle" ? SpinnerWhite : undefined}
                  >
                    Next
                  </Button>
                }
                cancelButton={
                  <Button
                    variant="tertiary/medium"
                    onClick={handleSkipOnboarding}
                  >
                    Cancel
                  </Button>
                }
              />
            </div>
          )}

          {/* Step: Environment Variables Sync */}
          {showEnvVarSync && (
            <CompleteOnboardingForm method="post" action={actionUrl} onSubmit={handleFinishOnboarding}>
              <input type="hidden" name="action" value="complete-onboarding" />
              <input
                type="hidden"
                name="vercelStagingEnvironment"
                value={vercelStagingEnvironment || ""}
              />
              {vercelStagingEnvironment && (
                <input
                  type="hidden"
                  name="vercelStagingName"
                  value={
                    customEnvironments.find((e) => e.id === vercelStagingEnvironment)?.slug || ""
                  }
                />
              )}
              <input
                type="hidden"
                name="syncEnvVarsMapping"
                value={JSON.stringify(syncEnvVarsMapping)}
              />
              {nextUrl && (
                <input
                  type="hidden"
                  name="next"
                  value={nextUrl}
                />
              )}

              <div className="flex flex-col gap-4">
                <Header3>Sync Environment Variables</Header3>

                {/* Stats */}
                <div className="flex gap-4 text-sm">
                  <div className="rounded border bg-charcoal-750 px-3 py-2">
                    <span className="font-medium text-text-bright">{syncableEnvVars.length}</span>
                    <span className="text-text-dimmed"> can be synced</span>
                  </div>
                  {secretEnvVars.length > 0 && (
                    <div className="rounded border bg-charcoal-750 px-3 py-2">
                      <span className="font-medium text-amber-400">{secretEnvVars.length}</span>
                      <span className="text-text-dimmed"> secret (cannot sync)</span>
                    </div>
                  )}
                </div>

                {/* Main toggle */}
                <div className="flex items-center justify-between rounded border bg-charcoal-800 p-3">
                  <div>
                    <Label>Sync all environment variables</Label>
                    <Hint>Enable syncing of environment variables from Vercel during builds.</Hint>
                  </div>
                  <Switch
                    name="pullEnvVarsFromVercel"
                    variant="small"
                    checked={pullEnvVarsFromVercel}
                    onCheckedChange={handleToggleAll}
                  />
                </div>

                {/* Expandable env var list */}
                {pullEnvVarsFromVercel && envVars.length > 0 && (
                  <div className="rounded border">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between p-3 text-left"
                      onClick={() => setExpandedEnvVars(!expandedEnvVars)}
                    >
                      <span className="text-sm text-text-dimmed">
                        {enabledEnvVars.length} of {syncableEnvVars.length} variables will be synced
                      </span>
                      {expandedEnvVars ? (
                        <ChevronUpIcon className="size-4" />
                      ) : (
                        <ChevronDownIcon className="size-4" />
                      )}
                    </button>

                    {expandedEnvVars && (
                      <div className="max-h-64 overflow-y-auto border-t">
                        {envVars.map((envVar) => (
                          <div
                            key={envVar.id}
                            className="flex items-center justify-between gap-2 border-b px-3 py-2 last:border-b-0"
                          >
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="truncate font-mono text-xs">{envVar.key}</span>
                              {envVar.target && envVar.target.length > 0 && (
                                <span className="text-xs text-text-dimmed">
                                  {formatVercelTargets(envVar.target)}
                                  {envVar.isShared && " · Shared"}
                                </span>
                              )}
                            </div>
                            {envVar.isSecret ? (
                              <span className="shrink-0 text-xs text-amber-400">Secret</span>
                            ) : (
                              <Switch
                                variant="small"
                                checked={shouldSyncEnvVarForAnyEnvironment(syncEnvVarsMapping, envVar.key)}
                                onCheckedChange={(checked) =>
                                  handleToggleEnvVar(envVar.key, checked)
                                }
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant="primary/medium"
                      disabled={completeOnboardingFetcher.state !== "idle"}
                      LeadingIcon={completeOnboardingFetcher.state !== "idle" ? SpinnerWhite : undefined}
                    >
                      Finish
                    </Button>
                  }
                  cancelButton={
                    hasCustomEnvs ? (
                      <Button
                        variant="tertiary/medium"
                        onClick={() => setState("env-mapping")}
                      >
                        Back
                      </Button>
                    ) : (
                      <Button
                        variant="tertiary/medium"
                        onClick={handleSkipOnboarding}
                        disabled={fetcher.state !== "idle"}
                      >
                        Cancel
                      </Button>
                    )
                  }
                />
              </div>
            </CompleteOnboardingForm>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Export components for use in other routes
export { VercelSettingsPanel, VercelOnboardingModal };
