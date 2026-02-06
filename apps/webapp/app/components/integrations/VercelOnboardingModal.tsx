import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "@heroicons/react/20/solid";
import {
  useFetcher,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import { useTypedFetcher } from "remix-typedjson";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "~/components/primitives/Tooltip";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { BuildSettingsFields } from "~/components/integrations/VercelBuildSettings";
import { OctoKitty } from "~/components/GitHubLoginButton";
import {
  ConnectGitHubRepoModal,
} from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github";
import {
  type SyncEnvVarsMapping,
  type EnvSlug,
  ALL_ENV_SLUGS,
  shouldSyncEnvVarForAnyEnvironment,
  getAvailableEnvSlugs,
  getAvailableEnvSlugsForBuildSettings,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { type VercelCustomEnvironment } from "~/models/vercelIntegration.server";
import { type VercelOnboardingData } from "~/presenters/v3/VercelSettingsPresenter.server";
import { vercelAppInstallPath, v3ProjectSettingsPath, githubAppInstallPath, vercelResourcePath } from "~/utils/pathBuilder";
import type { loader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.vercel";
import { useEffect, useState, useCallback, useRef } from "react";

function safeRedirectUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin) {
      return parsed.toString();
    }
    if (parsed.protocol === "https:" && /^([a-z0-9-]+\.)*vercel\.com$/i.test(parsed.hostname)) {
      return parsed.toString();
    }
  } catch {
    // Invalid URL
  }
  return null;
}

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

type OnboardingState =
  | "idle"
  | "installing"
  | "loading-projects"
  | "project-selection"
  | "loading-env-mapping"
  | "env-mapping"
  | "loading-env-vars"
  | "env-var-sync"
  | "build-settings"
  | "github-connection"
  | "completed";

export function VercelOnboardingModal({
  isOpen,
  onClose,
  onboardingData,
  organizationSlug,
  projectSlug,
  environmentSlug,
  hasStagingEnvironment,
  hasPreviewEnvironment,
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
  hasPreviewEnvironment: boolean;
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
    // For marketplace origin, skip env-mapping step and go directly to env-var-sync
    if (!fromMarketplaceContext) {
      const customEnvs = (onboardingData?.customEnvironments?.length ?? 0) > 0 && hasStagingEnvironment;
      if (customEnvs) {
        return "env-mapping";
      }
    }
    if (!onboardingData?.environmentVariables || onboardingData.environmentVariables.length === 0) {
      return "loading-env-vars";
    }
    return "env-var-sync";
  }, [hasOrgIntegration, onboardingData, hasStagingEnvironment, fromMarketplaceContext]);

  const [state, setState] = useState<OnboardingState>(() => {
    if (!isOpen) return "idle";
    return computeInitialState();
  });

  const prevIsOpenRef = useRef(isOpen);
  const hasSyncedStagingRef = useRef(false);
  const hasSyncedPreviewRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      setState(computeInitialState());
      hasSyncedStagingRef.current = false;
      hasSyncedPreviewRef.current = false;
    } else if (isOpen && state === "idle") {
      setState(computeInitialState());
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, state, computeInitialState]);

  const [selectedVercelProject, setSelectedVercelProject] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [vercelStagingEnvironment, setVercelStagingEnvironment] = useState<{
    environmentId: string;
    displayName: string;
  } | null>(null);
  const availableEnvSlugsForOnboarding = getAvailableEnvSlugs(hasStagingEnvironment, hasPreviewEnvironment);
  const availableEnvSlugsForOnboardingBuildSettings = getAvailableEnvSlugsForBuildSettings(hasStagingEnvironment, hasPreviewEnvironment);
  const [pullEnvVarsBeforeBuild, setPullEnvVarsBeforeBuild] = useState<EnvSlug[]>(
    () => availableEnvSlugsForOnboardingBuildSettings
  );
  const [atomicBuilds, setAtomicBuilds] = useState<EnvSlug[]>(
    () => ["prod"]
  );
  const [discoverEnvVars, setDiscoverEnvVars] = useState<EnvSlug[]>(
    () => availableEnvSlugsForOnboardingBuildSettings
  );

  // Sync pullEnvVarsBeforeBuild and discoverEnvVars when hasStagingEnvironment becomes true (once)
  useEffect(() => {
    if (hasStagingEnvironment && !hasSyncedStagingRef.current) {
      hasSyncedStagingRef.current = true;
      setPullEnvVarsBeforeBuild((prev) => {
        if (!prev.includes("stg")) {
          return [...prev, "stg"];
        }
        return prev;
      });
      setDiscoverEnvVars((prev) => {
        if (!prev.includes("stg")) {
          return [...prev, "stg"];
        }
        return prev;
      });
    }
  }, [hasStagingEnvironment]);

  // Sync pullEnvVarsBeforeBuild and discoverEnvVars when hasPreviewEnvironment becomes true (once)
  useEffect(() => {
    if (hasPreviewEnvironment && !hasSyncedPreviewRef.current) {
      hasSyncedPreviewRef.current = true;
      setPullEnvVarsBeforeBuild((prev) => {
        if (!prev.includes("preview")) {
          return [...prev, "preview"];
        }
        return prev;
      });
      setDiscoverEnvVars((prev) => {
        if (!prev.includes("preview")) {
          return [...prev, "preview"];
        }
        return prev;
      });
    }
  }, [hasPreviewEnvironment]);
  const [syncEnvVarsMapping, setSyncEnvVarsMapping] = useState<SyncEnvVarsMapping>({});
  const [expandedEnvVars, setExpandedEnvVars] = useState(false);
  const [expandedSecretEnvVars, setExpandedSecretEnvVars] = useState(false);
  const [projectSelectionError, setProjectSelectionError] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);

  const gitHubAppInstallations = onboardingData?.gitHubAppInstallations ?? [];
  const isGitHubConnectedForOnboarding = onboardingData?.isGitHubConnected ?? false;
  const isOnboardingComplete = onboardingData?.isOnboardingComplete ?? false;

  const hasTriggeredMarketplaceRedirectRef = useRef(false);

  // Auto-redirect for marketplace flow when returning from GitHub with everything complete
  useEffect(() => {
    if (hasTriggeredMarketplaceRedirectRef.current) {
      return;
    }

    if (
      isOpen &&
      fromMarketplaceContext &&
      nextUrl &&
      isOnboardingComplete &&
      isGitHubConnectedForOnboarding
    ) {
      hasTriggeredMarketplaceRedirectRef.current = true;
      const validUrl = safeRedirectUrl(nextUrl);
      if (validUrl) {
        setTimeout(() => {
          window.location.href = validUrl;
        }, 100);
      }
    }
  }, [isOpen, fromMarketplaceContext, nextUrl, isOnboardingComplete, isGitHubConnectedForOnboarding]);

  useEffect(() => {
    if (!isOpen) {
      hasTriggeredMarketplaceRedirectRef.current = false;
      setIsRedirecting(false);
    }
  }, [isOpen]);

  const loadingStateRef = useRef<OnboardingState | null>(null);

  useEffect(() => {
    if (!isOpen || state === "idle") {
      loadingStateRef.current = null;
      return;
    }

    if (onboardingData?.authInvalid) {
      onClose();
      return;
    }

    if (loadingStateRef.current === state) {
      return;
    }

    switch (state) {

      case "loading-projects":
        loadingStateRef.current = state;
        if (onDataReload) {
          onDataReload();
        }
        break;

      case "loading-env-mapping":
        loadingStateRef.current = state;
        if (onDataReload) {
          onDataReload();
        }
        break;

      case "loading-env-vars":
        loadingStateRef.current = state;
        if (onDataReload) {
          onDataReload(vercelStagingEnvironment?.environmentId || undefined);
        }
        break;

      case "installing":
      case "project-selection":
      case "env-mapping":
      case "env-var-sync":
      case "completed":
      case "build-settings":
      case "github-connection":
        loadingStateRef.current = null;
        break;
    }
  }, [isOpen, state, onboardingData?.authInvalid, vercelStagingEnvironment, onDataReload, onClose]);

  useEffect(() => {
    if (!onboardingData?.authInvalid && state === "loading-projects" && onboardingData?.availableProjects !== undefined) {
      setState("project-selection");
    }
  }, [state, onboardingData?.availableProjects, onboardingData?.authInvalid]);

  useEffect(() => {
    if (!onboardingData?.authInvalid && state === "loading-env-vars" && onboardingData?.environmentVariables) {
      setState("env-var-sync");
    }
  }, [state, onboardingData?.environmentVariables, onboardingData?.authInvalid]);

  useEffect(() => {
    if (state === "project-selection" && fetcher.data && "success" in fetcher.data && fetcher.data.success && fetcher.state === "idle") {
      setState("loading-env-mapping");
      if (onDataReload) {
        onDataReload();
      }
    } else if (fetcher.data && "error" in fetcher.data && typeof fetcher.data.error === "string") {
      setProjectSelectionError(fetcher.data.error);
    }
  }, [state, fetcher.data, fetcher.state, onDataReload]);

  // For marketplace origin, skip env-mapping step
  useEffect(() => {
    if (state === "loading-env-mapping" && onboardingData) {
      const hasCustomEnvs = (onboardingData.customEnvironments?.length ?? 0) > 0 && hasStagingEnvironment;
      if (hasCustomEnvs && !fromMarketplaceContext) {
        setState("env-mapping");
      } else {
        setState("loading-env-vars");
      }
    }
  }, [state, onboardingData, hasStagingEnvironment, fromMarketplaceContext]);

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
      const newMapping = { ...prev };

      if (enabled) {
        for (const envSlug of ALL_ENV_SLUGS) {
          if (newMapping[envSlug]) {
            const { [key]: _, ...rest } = newMapping[envSlug];
            if (Object.keys(rest).length === 0) {
              delete newMapping[envSlug];
            } else {
              newMapping[envSlug] = rest;
            }
          }
        }
      } else {
        for (const envSlug of ALL_ENV_SLUGS) {
          newMapping[envSlug] = {
            ...(newMapping[envSlug] || {}),
            [key]: false,
          };
        }
      }

      return newMapping;
    });
  }, []);

  const handleToggleAllEnvVars = useCallback(
    (enabled: boolean, syncableVars: Array<{ key: string }>) => {
      if (enabled) {
        setSyncEnvVarsMapping({});
      } else {
        const newMapping: SyncEnvVarsMapping = {};
        for (const envSlug of ALL_ENV_SLUGS) {
          newMapping[envSlug] = {};
          for (const v of syncableVars) {
            newMapping[envSlug][v.key] = false;
          }
        }
        setSyncEnvVarsMapping(newMapping);
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
    setVercelStagingEnvironment(null);
    setState("loading-env-vars");
  }, []);

  const handleUpdateEnvMapping = useCallback(() => {
    if (!vercelStagingEnvironment) {
      setState("loading-env-vars");
      return;
    }

    const formData = new FormData();
    formData.append("action", "update-env-mapping");
    formData.append("vercelStagingEnvironment", JSON.stringify(vercelStagingEnvironment));

    envMappingFetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });

  }, [vercelStagingEnvironment, envMappingFetcher, actionUrl]);

  const handleBuildSettingsNext = useCallback(() => {
    if (nextUrl && fromMarketplaceContext && isGitHubConnectedForOnboarding) {
      setIsRedirecting(true);
    }

    const formData = new FormData();
    formData.append("action", "complete-onboarding");
    formData.append("vercelStagingEnvironment", vercelStagingEnvironment ? JSON.stringify(vercelStagingEnvironment) : "");
    formData.append("pullEnvVarsBeforeBuild", JSON.stringify(pullEnvVarsBeforeBuild));
    formData.append("atomicBuilds", JSON.stringify(atomicBuilds));
    formData.append("discoverEnvVars", JSON.stringify(discoverEnvVars));
    formData.append("syncEnvVarsMapping", JSON.stringify(syncEnvVarsMapping));
    if (nextUrl && fromMarketplaceContext && isGitHubConnectedForOnboarding) {
      formData.append("next", nextUrl);
    }

    if (!isGitHubConnectedForOnboarding) {
      formData.append("skipRedirect", "true");
    }

    completeOnboardingFetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });

    if (!isGitHubConnectedForOnboarding) {
      setState("github-connection");
    }
  }, [vercelStagingEnvironment, pullEnvVarsBeforeBuild, atomicBuilds, discoverEnvVars, syncEnvVarsMapping, nextUrl, fromMarketplaceContext, isGitHubConnectedForOnboarding, completeOnboardingFetcher, actionUrl]);

  const handleFinishOnboarding = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    completeOnboardingFetcher.submit(formData, {
      method: "post",
      action: actionUrl,
    });
  }, [completeOnboardingFetcher, actionUrl]);

  useEffect(() => {
    if (completeOnboardingFetcher.data && typeof completeOnboardingFetcher.data === "object" && "success" in completeOnboardingFetcher.data && completeOnboardingFetcher.data.success && completeOnboardingFetcher.state === "idle") {
      if (state === "github-connection") {
        return;
      }
      if ("redirectTo" in completeOnboardingFetcher.data && typeof completeOnboardingFetcher.data.redirectTo === "string") {
        const validRedirect = safeRedirectUrl(completeOnboardingFetcher.data.redirectTo);
        if (validRedirect) {
          window.location.href = validRedirect;
        }
        return;
      }
      setState("completed");
    }
  }, [completeOnboardingFetcher.data, completeOnboardingFetcher.state, state]);

  useEffect(() => {
    if (state === "completed") {
      onClose();
    }
  }, [state, onClose]);

  useEffect(() => {
    if (state === "installing") {
      const installUrl = vercelAppInstallPath(organizationSlug, projectSlug);
      window.location.href = installUrl;
    }
  }, [state, organizationSlug, projectSlug]);

  useEffect(() => {
    if (envMappingFetcher.data && typeof envMappingFetcher.data === "object" && "success" in envMappingFetcher.data && envMappingFetcher.data.success && envMappingFetcher.state === "idle") {
      setState("loading-env-vars");
    }
  }, [envMappingFetcher.data, envMappingFetcher.state]);

  useEffect(() => {
    if (state === "env-mapping" && customEnvironments.length > 0 && !vercelStagingEnvironment) {
      let selectedEnv: VercelCustomEnvironment;

      if (customEnvironments.length === 1) {
        selectedEnv = customEnvironments[0];
      } else {
        const stagingEnv = customEnvironments.find(
          (env) => env.slug.toLowerCase() === "staging"
        );
        selectedEnv = stagingEnv ?? customEnvironments[0];
      }

      setVercelStagingEnvironment({ environmentId: selectedEnv.id, displayName: selectedEnv.slug });
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
              <VercelLogo className="size-5" />
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
  const showBuildSettings = state === "build-settings";
  const showGitHubConnection = state === "github-connection";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !fromMarketplaceContext && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <VercelLogo className="size-5" />
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
                value={vercelStagingEnvironment?.environmentId || ""}
                setValue={(value) => {
                  if (!Array.isArray(value)) {
                    const env = customEnvironments.find((e) => e.id === value);
                    setVercelStagingEnvironment(
                      env ? { environmentId: env.id, displayName: env.slug } : null
                    );
                  }
                }}
                items={customEnvironments}
                variant="tertiary/medium"
                placeholder="Select environment"
                dropdownIcon
                text={vercelStagingEnvironment?.displayName || "Select environment"}
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
                  {!fromMarketplaceContext && (
                    <Button
                      variant="tertiary/medium"
                      onClick={handleSkipEnvMapping}
                    >
                      Skip
                    </Button>
                  )}
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
            <div className="flex flex-col gap-4">
              <Header3>Pull Environment Variables</Header3>
              <Paragraph className="text-sm">
                Select which environment variables to pull from Vercel now. This is a one-time pull.
              </Paragraph>

              <div className="flex gap-4 text-sm">
                <div className="rounded border bg-charcoal-750 px-3 py-2">
                  <span className="font-medium text-text-bright">{syncableEnvVars.length}</span>
                  <span className="text-text-dimmed"> can be pulled</span>
                </div>
                {secretEnvVars.length > 0 && (
                  <div className="rounded border bg-charcoal-750 px-3 py-2">
                    <span className="font-medium text-amber-400">{secretEnvVars.length}</span>
                    <span className="text-text-dimmed"> secret (cannot pull)</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between rounded border bg-charcoal-800 p-3">
                <div>
                  <Label>Pull all environment variables now</Label>
                  <Hint>Select all variables to pull from Vercel.</Hint>
                </div>
                <Switch
                  variant="small"
                  checked={enabledEnvVars.length === syncableEnvVars.length}
                  onCheckedChange={(checked) => handleToggleAllEnvVars(checked, syncableEnvVars)}
                />
              </div>

              {syncableEnvVars.length > 0 && (
                <div className="rounded border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between p-3 text-left"
                    onClick={() => setExpandedEnvVars(!expandedEnvVars)}
                  >
                    <span className="text-sm text-text-dimmed">
                      {enabledEnvVars.length} of {syncableEnvVars.length} variables will be pulled
                    </span>
                    {expandedEnvVars ? (
                      <ChevronUpIcon className="size-4" />
                    ) : (
                      <ChevronDownIcon className="size-4" />
                    )}
                  </button>

                  {expandedEnvVars && (
                    <div className="max-h-64 overflow-y-auto border-t">
                      {syncableEnvVars.map((envVar) => (
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
                                    ].environments.join(", ")}`}
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
                          <Switch
                            variant="small"
                            checked={shouldSyncEnvVarForAnyEnvironment(syncEnvVarsMapping, envVar.key)}
                            onCheckedChange={(checked) =>
                              handleToggleEnvVar(envVar.key, checked)
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {secretEnvVars.length > 0 && (
                <div className="rounded border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between p-3 text-left"
                    onClick={() => setExpandedSecretEnvVars(!expandedSecretEnvVars)}
                  >
                    <span className="text-sm text-text-dimmed">
                      {secretEnvVars.length} secret {secretEnvVars.length === 1 ? "variable" : "variables"} (cannot be pulled)
                    </span>
                    {expandedSecretEnvVars ? (
                      <ChevronUpIcon className="size-4" />
                    ) : (
                      <ChevronDownIcon className="size-4" />
                    )}
                  </button>

                  {expandedSecretEnvVars && (
                    <div className="max-h-64 overflow-y-auto border-t">
                      {secretEnvVars.map((envVar) => (
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
                          <span className="shrink-0 text-xs text-amber-400">Secret</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {overlappingEnvVarsCount > 0 && enabledEnvVars.length > 0 && (
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
                    variant="primary/medium"
                    onClick={() => {
                      if (fromMarketplaceContext) {
                        handleBuildSettingsNext();
                      } else {
                        setState("build-settings");
                      }
                    }}
                    disabled={fromMarketplaceContext && (completeOnboardingFetcher.state !== "idle" || isRedirecting)}
                    LeadingIcon={fromMarketplaceContext && (completeOnboardingFetcher.state !== "idle" || isRedirecting) ? SpinnerWhite : undefined}
                  >
                    {fromMarketplaceContext ? (isGitHubConnectedForOnboarding ? "Finish" : "Next") : "Next"}
                  </Button>
                }
                cancelButton={
                  hasCustomEnvs && !fromMarketplaceContext ? (
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
          )}

          {showBuildSettings && (
            <div className="flex flex-col gap-4">
              <Header3>Build Settings</Header3>
              <Paragraph className="text-sm">
                Configure how environment variables are pulled during builds and atomic deployments.
              </Paragraph>

              <BuildSettingsFields
                availableEnvSlugs={availableEnvSlugsForOnboardingBuildSettings}
                pullEnvVarsBeforeBuild={pullEnvVarsBeforeBuild}
                onPullEnvVarsChange={setPullEnvVarsBeforeBuild}
                discoverEnvVars={discoverEnvVars}
                onDiscoverEnvVarsChange={setDiscoverEnvVars}
                atomicBuilds={atomicBuilds}
                onAtomicBuildsChange={setAtomicBuilds}
              />

              <FormButtons
                confirmButton={
                  <Button
                    variant="primary/medium"
                    onClick={handleBuildSettingsNext}
                    disabled={completeOnboardingFetcher.state !== "idle" || isRedirecting}
                    LeadingIcon={completeOnboardingFetcher.state !== "idle" || isRedirecting ? SpinnerWhite : undefined}
                  >
                    {isGitHubConnectedForOnboarding ? "Finish" : "Next"}
                  </Button>
                }
                cancelButton={
                  <Button
                    variant="tertiary/medium"
                    onClick={() => setState("env-var-sync")}
                  >
                    Back
                  </Button>
                }
              />
            </div>
          )}

          {showGitHubConnection && (
            <div className="flex flex-col gap-4">
              <Header3>Connect GitHub Repository</Header3>
              <Paragraph className="text-sm">
                To fully integrate with Vercel, Trigger.dev needs access to your source code.
                This allows automatic deployments and build synchronization.
              </Paragraph>

              <Callout variant="info">
                <p className="text-xs">
                  Connecting your GitHub repository enables Trigger.dev to read your source code
                  and automatically create deployments when you push changes to Vercel.
                </p>
              </Callout>

              {(() => {
                const baseSettingsPath = v3ProjectSettingsPath(
                  { slug: organizationSlug },
                  { slug: projectSlug },
                  { slug: environmentSlug }
                );
                const redirectParams = new URLSearchParams();
                redirectParams.set("vercelOnboarding", "true");
                if (fromMarketplaceContext) {
                  redirectParams.set("origin", "marketplace");
                }
                if (nextUrl) {
                  redirectParams.set("next", nextUrl);
                }
                const redirectUrlWithContext = `${baseSettingsPath}?${redirectParams.toString()}`;

                return gitHubAppInstallations.length === 0 ? (
                  <div className="flex flex-col gap-3">
                    <LinkButton
                      to={githubAppInstallPath(
                        organizationSlug,
                        `${redirectUrlWithContext}&openGithubRepoModal=1`
                      )}
                      variant="secondary/medium"
                      LeadingIcon={OctoKitty}
                    >
                      Install GitHub app
                    </LinkButton>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                      <ConnectGitHubRepoModal
                        gitHubAppInstallations={gitHubAppInstallations}
                        organizationSlug={organizationSlug}
                        projectSlug={projectSlug}
                        environmentSlug={environmentSlug}
                        redirectUrl={redirectUrlWithContext}
                        preventDismiss={fromMarketplaceContext}
                      />
                      <span className="flex items-center gap-1 text-xs text-text-dimmed">
                        <CheckCircleIcon className="size-4 text-success" /> GitHub app is installed
                      </span>
                    </div>
                  </div>
                );
              })()}

              <FormButtons
                confirmButton={
                  isGitHubConnectedForOnboarding && fromMarketplaceContext && nextUrl ? (
                    <Button
                      variant="primary/medium"
                      onClick={() => {
                        setState("completed");
                        const validUrl = safeRedirectUrl(nextUrl);
                        if (validUrl) {
                          window.location.href = validUrl;
                        }
                      }}
                    >
                      Complete
                    </Button>
                  ) : (
                    <Button
                      variant="tertiary/medium"
                      onClick={() => {
                        setState("completed");
                        if (fromMarketplaceContext && nextUrl) {
                          const validUrl = safeRedirectUrl(nextUrl);
                          if (validUrl) {
                            window.location.href = validUrl;
                          }
                        }
                      }}
                    >
                      Skip for now
                    </Button>
                  )
                }
                cancelButton={
                  isGitHubConnectedForOnboarding && fromMarketplaceContext && nextUrl ? (
                    <Button
                      variant="tertiary/medium"
                      onClick={() => {
                        setState("completed");
                      }}
                    >
                      Skip for now
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
