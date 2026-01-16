import { useForm } from "@conform-to/react";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider
} from "~/components/primitives/Tooltip";
import {
  redirectBackWithErrorMessage,
  redirectWithSuccessMessage,
  redirectWithErrorMessage,
} from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3ProjectSettingsPath, vercelAppInstallPath } from "~/utils/pathBuilder";
import {
  VercelSettingsPresenter,
  type VercelOnboardingData,
} from "~/presenters/v3/VercelSettingsPresenter.server";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import {
  VercelIntegrationRepository,
  type VercelCustomEnvironment,
} from "~/models/vercelIntegration.server";
import {
  type VercelProjectIntegrationData,
  type SyncEnvVarsMapping,
  shouldSyncEnvVarForAnyEnvironment,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { useEffect, useState, useCallback, useRef } from "react";
import { RuntimeEnvironmentType } from "@trigger.dev/database";

function shortEnvironmentLabel(environment: RuntimeEnvironmentType) {
  switch (environment.toUpperCase()) {
    case "PRODUCTION":
      return "Prod";
    case "STAGING":
      return "Staging";
    case "DEVELOPMENT":
      return "Dev";
    case "PREVIEW":
      return "Preview";
  }
}

export type ConnectedVercelProject = {
  id: string;
  vercelProjectId: string;
  vercelProjectName: string;
  vercelTeamId: string | null;
  integrationData: VercelProjectIntegrationData;
  createdAt: Date;
};

function formatVercelTargets(targets: string[]): string {
  const targetLabels: Record<string, string> = {
    production: "Production",
    preview: "Preview",
    development: "Development",
    staging: "Staging",
  };

  return targets
    .map((t) => targetLabels[t.toLowerCase()] || t)
    .join(", ");
}

async function lookupVercelEnvironmentName(
  projectId: string,
  environmentId: string | null
): Promise<string | null> {
  if (!environmentId) {
    return null;
  }

  try {
    const vercelService = new VercelIntegrationService();
    const projectIntegration = await vercelService.getVercelProjectIntegration(projectId);
    if (!projectIntegration) {
      return null;
    }

    const orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationForProject(projectId);
    if (!orgIntegration) {
      return null;
    }

    const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);
    const client = await VercelIntegrationRepository.getVercelClient(orgIntegration);

    const customEnvironmentsResult = await VercelIntegrationRepository.getVercelCustomEnvironments(
      client,
      projectIntegration.parsedIntegrationData.vercelProjectId,
      teamId
    );

    if (!customEnvironmentsResult.success) {
      return null;
    }

    const environment = customEnvironmentsResult.data.find((env: VercelCustomEnvironment) => env.id === environmentId);
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

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
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

    if (!resultOrFail?.isOk()) {
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
      authInvalid: authInvalid || result.authInvalid,
      onboardingData,
      organizationSlug,
      projectSlug: projectParam,
      environmentSlug: envParam,
      projectId: project.id,
      organizationId: project.organizationId,
    });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    logger.error("Unexpected error in Vercel settings loader", {
      url: request.url,
      params,
      error,
    });
    
    throw new Response("Internal Server Error", { status: 500 });
  }
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

    if (result) {
      return redirectWithSuccessMessage(settingsPath, request, "Vercel settings updated successfully");
    }

    return redirectWithErrorMessage(settingsPath, request, "Failed to update Vercel settings");
  }

  // Handle disconnect action
  if (actionType === "disconnect") {
    const success = await vercelService.disconnectVercelProject(project.id);

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
      // Return JSON with redirect URL for fetcher to handle
      return json({ success: true, redirectTo: settingsPath });
    }

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

export function vercelResourcePath(
  organizationSlug: string,
  projectSlug: string,
  environmentSlug: string
) {
  return `/resources/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/vercel`;
}

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
                      : () => <VercelIcon className="size-4 -mx-1" />
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
        GitHub integration is not connected. Vercel integration cannot sync environment variables or
        spawn Trigger.dev builds without a properly installed GitHub integration.
      </p>
    </Callout>
  );
}

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
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <Label>Staging environment mapping</Label>
                      <Hint>
                        Vercel environment mapped to Trigger.dev's Staging environment.
                      </Hint>
                    </div>
                    <span className="font-mono text-sm text-text-bright break-all">
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
          customEnvironments={data.onboardingData?.customEnvironments}
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
              ? "Connect your Vercel project to sync environment variables and trigger builds automatically."
              : "Install the Vercel app to connect your projects and sync environment variables."}
          </Hint>
          {!data.isGitHubConnected && (
            <Hint>
              GitHub integration is not connected. Vercel integration cannot sync environment variables or
              spawn Trigger.dev builds without a properly installed GitHub integration.
            </Hint>
          )}
        </>
      )}
    </div>
  );
}

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
  onDataReload?: (vercelStagingEnvironment?: string) => void;
}) {
  const navigation = useNavigation();
  const fetcher = useTypedFetcher<typeof loader>();
  const envMappingFetcher = useFetcher();
  const completeOnboardingFetcher = useFetcher();
  const { Form: CompleteOnboardingForm } = completeOnboardingFetcher;
  const [searchParams] = useSearchParams();
  const fromMarketplaceContext = searchParams.get("origin") === "marketplace";

  const availableProjects = onboardingData?.availableProjects || [];
  const hasProjectSelected = onboardingData?.hasProjectSelected ?? false;
  const customEnvironments = onboardingData?.customEnvironments || [];
  const envVars = onboardingData?.environmentVariables || [];
  const existingVars = onboardingData?.existingVariables || {};
  const hasCustomEnvs = customEnvironments.length > 0 && hasStagingEnvironment;

  const computeInitialState = useCallback((): OnboardingState => {
    if (!hasOrgIntegration || onboardingData?.authInvalid) {
      return "idle";
    }
    const projectSelected = onboardingData?.hasProjectSelected ?? false;
    if (!projectSelected) {
      if (!onboardingData?.availableProjects || onboardingData.availableProjects.length === 0) {
        return "loading-projects";
      }
      return "project-selection";
    }
    const customEnvs = (onboardingData?.customEnvironments?.length ?? 0) > 0 && hasStagingEnvironment;
    if (customEnvs) {
      return "env-mapping";
    }
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

  useEffect(() => {
    if (!isOpen || state === "idle") {
      return;
    }

    if (onboardingData?.authInvalid) {
      onClose();
      return;
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
          onDataReload(vercelStagingEnvironment || undefined);
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
  }, [isOpen, state, hasOrgIntegration, hasProjectSelected, onboardingData, hasCustomEnvs, hasStagingEnvironment, vercelStagingEnvironment, onDataReload]);

  // Watch for data loading completion
  useEffect(() => {
    if (!onboardingData?.authInvalid && state === "loading-projects" && onboardingData?.availableProjects !== undefined) {
      // Projects loaded (whether empty or not), transition to project selection
      setState("project-selection");
    }
  }, [state, onboardingData?.availableProjects, onboardingData?.authInvalid]);

  useEffect(() => {
    if (!onboardingData?.authInvalid && state === "loading-env-vars" && onboardingData?.environmentVariables) {
      // Environment variables loaded, transition to env-var-sync
      setState("env-var-sync");
    }
  }, [state, onboardingData?.environmentVariables, onboardingData?.authInvalid]);

  // Handle successful project selection - transition to loading-env-mapping
  useEffect(() => {
    if (state === "project-selection" && fetcher.data && "success" in fetcher.data && fetcher.data.success && fetcher.state === "idle") {
      // Project selection succeeded, transition to loading-env-mapping
      setState("loading-env-mapping");
      // Reload data to get updated project info and env vars
      if (onDataReload) {
        console.log("Vercel onboarding: Reloading data after successful project selection to get updated project info and env vars");
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

  const overlappingEnvVarsCount = enabledEnvVars.filter((v) => existingVars[v.key]).length;

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

  const handleProjectSelection = useCallback(async () => {
    if (!selectedVercelProject) {
      setProjectSelectionError("Please select a Vercel project");
      return;
    }

    setProjectSelectionError(null);

    const formData = new FormData();
    formData.append("action", "select-vercel-project");
    formData.append("vercelProjectId", selectedVercelProject.id);
    formData.append("vercelProjectName", selectedVercelProject.name);

    fetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });
  }, [selectedVercelProject, fetcher, actionUrl]);

  const handleSkipOnboarding = useCallback(() => {
    onClose();

    if (fromMarketplaceContext) {
      return window.close();
    }

    const formData = new FormData();
    formData.append("action", "skip-onboarding");
    fetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });
  }, [actionUrl, fetcher, onClose, nextUrl, fromMarketplaceContext]);

  const handleSkipEnvMapping = useCallback(() => {
    // Skip the env mapping step and go directly to loading env vars
    setVercelStagingEnvironment("");
    setState("loading-env-vars");
  }, []);

  const handleUpdateEnvMapping = useCallback(() => {
    if (!vercelStagingEnvironment) {
      setState("loading-env-vars");
      return;
    }

    // Save the environment mapping first
    const formData = new FormData();
    formData.append("action", "update-env-mapping");
    formData.append("vercelStagingEnvironment", vercelStagingEnvironment);
    const environment = customEnvironments.find((env) => env.id === vercelStagingEnvironment);
    if (environment) {
      formData.append("vercelStagingName", environment.slug);
    }

    envMappingFetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });
    
  }, [vercelStagingEnvironment, customEnvironments, envMappingFetcher, actionUrl, onDataReload]);

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

  // Preselect environment in env-mapping state
  useEffect(() => {
    if (state === "env-mapping" && customEnvironments.length > 0 && !vercelStagingEnvironment) {
      let selectedId = "";
      
      if (customEnvironments.length === 1) {
        // Only one environment, preselect it
        selectedId = customEnvironments[0].id;
      } else {
        // Multiple environments, check for 'staging' (case-insensitive)
        const stagingEnv = customEnvironments.find(
          (env) => env.slug.toLowerCase() === "staging"
        );
        selectedId = stagingEnv ? stagingEnv.id : customEnvironments[0].id;
      }
      
      setVercelStagingEnvironment(selectedId);
    }
  }, [state, customEnvironments, vercelStagingEnvironment]);

  if (!isOpen || onboardingData?.authInvalid) {
    return null;
  }

  const isLoadingState =
    state === "loading-projects" ||
    state === "loading-env-mapping" ||
    state === "loading-env-vars" ||
    state === "installing" ||
    (state === "idle" && !onboardingData);

  if (isLoadingState) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && !fromMarketplaceContext && onClose()}>
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

  const showProjectSelection = state === "project-selection";
  const showEnvMapping = state === "env-mapping";
  const showEnvVarSync = state === "env-var-sync";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !fromMarketplaceContext && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <VercelIcon className="size-5" />
            <span>Set up Vercel Integration</span>
          </div>
        </DialogHeader>

        <div className="mt-4">
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
                items={customEnvironments}
                variant="tertiary/medium"
                placeholder="Select environment"
                dropdownIcon
                text={
                  customEnvironments.find((e) => e.id === vercelStagingEnvironment)?.slug ||
                  "Select environment"
                }
              >
                {customEnvironments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {env.slug}
                  </SelectItem>
                ))}
              </Select>

              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="tertiary/medium"
                  onClick={handleSkipOnboarding}
                >
                  Cancel
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="tertiary/medium"
                    onClick={handleSkipEnvMapping}
                  >
                    Skip
                  </Button>
                  <Button
                    variant="primary/medium"
                    onClick={handleUpdateEnvMapping}
                    disabled={envMappingFetcher.state !== "idle"}
                    LeadingIcon={envMappingFetcher.state !== "idle" ? SpinnerWhite : undefined}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}

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
              {nextUrl && fromMarketplaceContext && (
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
                              {existingVars[envVar.key] ? (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="min-w-0 max-w-full cursor-default text-left truncate font-mono text-xs underline decoration-yellow-500 decoration-dotted underline-offset-2">
                                        {envVar.key}
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent className="flex items-center gap-1 text-xs">
                                      {`This variable is going to be replaced in: ${existingVars[
                                        envVar.key
                                      ].environments
                                        .map((e) => shortEnvironmentLabel(e))
                                        .join(", ")}`}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              ) : (
                                <span className="truncate font-mono text-xs">{envVar.key}</span>
                              )}
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
              
                {overlappingEnvVarsCount > 0 && pullEnvVarsFromVercel && (
                  <div className="flex items-center gap-2">
                    <ExclamationTriangleIcon className="h-4 w-4 text-amber-500" />
                    <span className="text-xs text-text-dimmed">
                      {overlappingEnvVarsCount} env vars are going to be updated (marked with{" "}
                      <span className="underline decoration-yellow-500 decoration-dotted underline-offset-2">
                        underline
                      </span>
                      )
                    </span>
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
