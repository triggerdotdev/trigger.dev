import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { CheckCircleIcon, LockClosedIcon, PlusIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigation, useNavigate, useSearchParams, useLocation } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { z } from "zod";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { DialogClose } from "@radix-ui/react-dialog";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import { TextLink } from "~/components/primitives/TextLink";
import { DateTime } from "~/components/primitives/DateTime";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import {
  EnvironmentIcon,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { GitBranchIcon } from "lucide-react";
import {
  redirectBackWithErrorMessage,
  redirectBackWithSuccessMessage,
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ProjectSettingsService } from "~/services/projectSettings.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import {
  githubAppInstallPath,
  EnvironmentParamSchema,
  v3ProjectSettingsPath,
} from "~/utils/pathBuilder";
import { cn } from "~/utils/cn";
import { type BranchTrackingConfig } from "~/v3/github";
import { GitHubSettingsPresenter } from "~/presenters/v3/GitHubSettingsPresenter.server";
import { useEffect, useState } from "react";

// ============================================================================
// Types
// ============================================================================

export type GitHubRepository = {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
};

export type GitHubAppInstallation = {
  id: string;
  appInstallationId: bigint;
  targetType: string;
  accountHandle: string;
  repositories: GitHubRepository[];
};

export type ConnectedGitHubRepo = {
  branchTracking: BranchTrackingConfig | undefined;
  previewDeploymentsEnabled: boolean;
  createdAt: Date;
  repository: GitHubRepository;
};

// ============================================================================
// Schemas
// ============================================================================

export const ConnectGitHubRepoFormSchema = z.object({
  action: z.literal("connect-repo"),
  installationId: z.string(),
  repositoryId: z.string(),
  redirectUrl: z.string().optional(),
});

export const DisconnectGitHubRepoFormSchema = z.object({
  action: z.literal("disconnect-repo"),
  redirectUrl: z.string().optional(),
});

export const UpdateGitSettingsFormSchema = z.object({
  action: z.literal("update-git-settings"),
  productionBranch: z.string().trim().optional(),
  stagingBranch: z.string().trim().optional(),
  previewDeploymentsEnabled: z
    .string()
    .optional()
    .transform((val) => val === "on"),
  redirectUrl: z.string().optional(),
});

const GitHubActionSchema = z.discriminatedUnion("action", [
  ConnectGitHubRepoFormSchema,
  DisconnectGitHubRepoFormSchema,
  UpdateGitSettingsFormSchema,
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

  const presenter = new GitHubSettingsPresenter();
  const resultOrFail = await presenter.call({
    projectId: project.id,
    organizationId: project.organizationId,
  });

  if (resultOrFail.isErr()) {
    throw new Response("Failed to load GitHub settings", { status: 500 });
  }

  return typedjson(resultOrFail.value);
}

// ============================================================================
// Action
// ============================================================================

function redirectWithMessage(
  request: Request,
  redirectUrl: string | undefined,
  message: string,
  type: "success" | "error"
) {
  if (type === "success") {
    return redirectUrl
      ? redirectWithSuccessMessage(redirectUrl, request, message)
      : redirectBackWithSuccessMessage(request, message);
  }
  return redirectUrl
    ? redirectWithErrorMessage(redirectUrl, request, message)
    : redirectBackWithErrorMessage(request, message);
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
  const submission = parse(formData, { schema: GitHubActionSchema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  const projectSettingsService = new ProjectSettingsService();
  const membershipResultOrFail = await projectSettingsService.verifyProjectMembership(
    organizationSlug,
    projectParam,
    userId
  );

  if (membershipResultOrFail.isErr()) {
    return json({ errors: { body: membershipResultOrFail.error.type } }, { status: 404 });
  }

  const { projectId, organizationId } = membershipResultOrFail.value;
  const { action: actionType } = submission.value;

  // Handle connect-repo action
  if (actionType === "connect-repo") {
    const { repositoryId, installationId, redirectUrl } = submission.value;

    const resultOrFail = await projectSettingsService.connectGitHubRepo(
      projectId,
      organizationId,
      repositoryId,
      installationId
    );

    if (resultOrFail.isOk()) {
      return redirectWithMessage(
        request,
        redirectUrl,
        "GitHub repository connected successfully",
        "success"
      );
    }

    const errorType = resultOrFail.error.type;

    if (errorType === "gh_repository_not_found") {
      return redirectWithMessage(request, redirectUrl, "GitHub repository not found", "error");
    }

    if (errorType === "project_already_has_connected_repository") {
      return redirectWithMessage(
        request,
        redirectUrl,
        "Project already has a connected repository",
        "error"
      );
    }

    logger.error("Failed to connect GitHub repository", { error: resultOrFail.error });
    return redirectWithMessage(
      request,
      redirectUrl,
      "Failed to connect GitHub repository",
      "error"
    );
  }

  // Handle disconnect-repo action
  if (actionType === "disconnect-repo") {
    const { redirectUrl } = submission.value;

    const resultOrFail = await projectSettingsService.disconnectGitHubRepo(projectId);

    if (resultOrFail.isOk()) {
      return redirectWithMessage(
        request,
        redirectUrl,
        "GitHub repository disconnected successfully",
        "success"
      );
    }

    logger.error("Failed to disconnect GitHub repository", { error: resultOrFail.error });
    return redirectWithMessage(
      request,
      redirectUrl,
      "Failed to disconnect GitHub repository",
      "error"
    );
  }

  // Handle update-git-settings action
  if (actionType === "update-git-settings") {
    const { productionBranch, stagingBranch, previewDeploymentsEnabled, redirectUrl } =
      submission.value;

    const resultOrFail = await projectSettingsService.updateGitSettings(
      projectId,
      productionBranch,
      stagingBranch,
      previewDeploymentsEnabled
    );

    if (resultOrFail.isOk()) {
      return redirectWithMessage(
        request,
        redirectUrl,
        "Git settings updated successfully",
        "success"
      );
    }

    const errorType = resultOrFail.error.type;

    const errorMessages: Record<string, string> = {
      github_app_not_enabled: "GitHub app is not enabled",
      connected_gh_repository_not_found: "Connected GitHub repository not found",
      production_tracking_branch_not_found: "Production tracking branch not found",
      staging_tracking_branch_not_found: "Staging tracking branch not found",
    };

    const message = errorMessages[errorType];
    if (message) {
      return redirectWithMessage(request, redirectUrl, message, "error");
    }

    logger.error("Failed to update Git settings", { error: resultOrFail.error });
    return redirectWithMessage(request, redirectUrl, "Failed to update Git settings", "error");
  }

  // Exhaustive check - this should never be reached
  submission.value satisfies never;
  return redirectBackWithErrorMessage(request, "Failed to process request");
}

// ============================================================================
// Helper: Build resource URL for fetching GitHub data
// ============================================================================

export function gitHubResourcePath(
  organizationSlug: string,
  projectSlug: string,
  environmentSlug: string
) {
  return `/resources/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/github`;
}

// ============================================================================
// Components
// ============================================================================

export function ConnectGitHubRepoModal({
  gitHubAppInstallations,
  organizationSlug,
  projectSlug,
  environmentSlug,
  redirectUrl,
}: {
  gitHubAppInstallations: GitHubAppInstallation[];
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  redirectUrl?: string;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const lastSubmission = useActionData() as any;
  const navigate = useNavigate();

  const [selectedInstallation, setSelectedInstallation] = useState<
    GitHubAppInstallation | undefined
  >(gitHubAppInstallations.at(0));

  const [selectedRepository, setSelectedRepository] = useState<GitHubRepository | undefined>(
    undefined
  );

  const navigation = useNavigation();
  const isConnectRepositoryLoading =
    navigation.formData?.get("action") === "connect-repo" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const [form, { installationId, repositoryId }] = useForm({
    id: "connect-repo",
    lastSubmission: lastSubmission,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: ConnectGitHubRepoFormSchema,
      });
    },
  });

  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const params = new URLSearchParams(searchParams);

    if (params.get("openGithubRepoModal") === "1") {
      setIsModalOpen(true);
      params.delete("openGithubRepoModal");
      setSearchParams(params);
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (lastSubmission && "success" in lastSubmission && lastSubmission.success === true) {
      setIsModalOpen(false);
    }
  }, [lastSubmission]);

  const actionUrl = gitHubResourcePath(organizationSlug, projectSlug, environmentSlug);

  return (
    <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={"secondary/medium"} LeadingIcon={OctoKitty}>
          Connect GitHub repo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Connect GitHub repository</DialogHeader>
        <div className="mt-2 flex flex-col gap-4">
          <Form method="post" action={actionUrl} {...form.props} className="w-full">
            {redirectUrl && <input type="hidden" name="redirectUrl" value={redirectUrl} />}
            <Paragraph className="mb-3">
              Choose a GitHub repository to connect to your project.
            </Paragraph>
            <Fieldset className="max-w-full gap-y-3">
              <InputGroup className="max-w-full">
                <Label htmlFor={installationId.id}>Account</Label>
                <Select
                  name={installationId.name}
                  id={installationId.id}
                  value={selectedInstallation?.id}
                  defaultValue={gitHubAppInstallations.at(0)?.id}
                  setValue={(value) => {
                    if (Array.isArray(value)) return;
                    const installation = gitHubAppInstallations.find((i) => i.id === value);
                    setSelectedInstallation(installation);
                    setSelectedRepository(undefined);
                  }}
                  items={gitHubAppInstallations}
                  variant="tertiary/small"
                  placeholder="Select account"
                  dropdownIcon
                  text={selectedInstallation ? selectedInstallation.accountHandle : undefined}
                >
                  {[
                    ...gitHubAppInstallations.map((installation) => (
                      <SelectItem
                        key={installation.id}
                        value={installation.id}
                        icon={<OctoKitty className="size-3 text-text-dimmed" />}
                      >
                        {installation.accountHandle}
                      </SelectItem>
                    )),
                    <SelectItem
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(
                          githubAppInstallPath(
                            organizationSlug,
                            `${v3ProjectSettingsPath(
                              { slug: organizationSlug },
                              { slug: projectSlug },
                              { slug: environmentSlug }
                            )}?openGithubRepoModal=1`
                          )
                        );
                      }}
                      key="new-account"
                      icon={<PlusIcon className="size-3 text-text-dimmed" />}
                    >
                      Add account
                    </SelectItem>,
                  ]}
                </Select>
                <FormError id={installationId.errorId}>{installationId.error}</FormError>
              </InputGroup>
              <InputGroup className="max-w-full">
                <Label htmlFor={repositoryId.id}>Repository</Label>
                <Select
                  name={repositoryId.name}
                  id={repositoryId.id}
                  value={selectedRepository ? selectedRepository.id : undefined}
                  setValue={(value) => {
                    if (Array.isArray(value)) return;
                    const repository = selectedInstallation?.repositories.find(
                      (r) => r.id === value
                    );
                    setSelectedRepository(repository);
                  }}
                  variant="tertiary/small"
                  placeholder="Select repository"
                  heading="Filter repositories"
                  dropdownIcon
                  items={selectedInstallation?.repositories ?? []}
                  filter={{ keys: ["name"] }}
                  disabled={!selectedInstallation || selectedInstallation.repositories.length === 0}
                  text={selectedRepository ? selectedRepository.name : null}
                >
                  {(matches) =>
                    matches.map((repo) => (
                      <SelectItem key={repo.id} value={repo.id}>
                        <div className="flex items-center gap-1">
                          {repo.name}
                          {repo.private && <LockClosedIcon className="size-3 text-text-dimmed" />}
                        </div>
                      </SelectItem>
                    ))
                  }
                </Select>
                <Hint className={cn("invisible", selectedInstallation && "visible")}>
                  Configure repository access in{" "}
                  <TextLink
                    target="_blank"
                    rel="noreferrer noopener"
                    to={`https://github.com/settings/installations/${selectedInstallation?.appInstallationId}`}
                  >
                    GitHub
                  </TextLink>
                  .
                </Hint>
                <FormError id={repositoryId.errorId}>{repositoryId.error}</FormError>
              </InputGroup>
              <FormError>{form.error}</FormError>
              <FormButtons
                confirmButton={
                  <Button
                    type="submit"
                    name="action"
                    value="connect-repo"
                    variant="primary/medium"
                    LeadingIcon={isConnectRepositoryLoading ? SpinnerWhite : undefined}
                    leadingIconClassName="text-white"
                    disabled={isConnectRepositoryLoading}
                  >
                    Connect repository
                  </Button>
                }
                cancelButton={
                  <DialogClose asChild>
                    <Button variant="tertiary/medium">Cancel</Button>
                  </DialogClose>
                }
              />
            </Fieldset>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function GitHubConnectionPrompt({
  gitHubAppInstallations,
  organizationSlug,
  projectSlug,
  environmentSlug,
  redirectUrl,
}: {
  gitHubAppInstallations: GitHubAppInstallation[];
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  redirectUrl?: string;
}) {

  const githubInstallationRedirect = redirectUrl || v3ProjectSettingsPath({ slug: organizationSlug }, { slug: projectSlug }, { slug: environmentSlug });
  return (
    <Fieldset>
      <InputGroup fullWidth>
        {gitHubAppInstallations.length === 0 && (
          <LinkButton
            to={githubAppInstallPath(
              organizationSlug,
              `${githubInstallationRedirect}?openGithubRepoModal=1`
            )}
            variant={"secondary/medium"}
            LeadingIcon={OctoKitty}
          >
            Install GitHub app
          </LinkButton>
        )}
        {gitHubAppInstallations.length !== 0 && (
          <div className="flex items-center gap-3">
            <ConnectGitHubRepoModal
              gitHubAppInstallations={gitHubAppInstallations}
              organizationSlug={organizationSlug}
              projectSlug={projectSlug}
              environmentSlug={environmentSlug}
              redirectUrl={redirectUrl}
            />
            <span className="flex items-center gap-1 text-xs text-text-dimmed">
              <CheckCircleIcon className="size-4 text-success" /> GitHub app is installed
            </span>
          </div>
        )}
      </InputGroup>
    </Fieldset>
  );
}

export function ConnectedGitHubRepoForm({
  connectedGitHubRepo,
  previewEnvironmentEnabled,
  organizationSlug,
  projectSlug,
  environmentSlug,
  billingPath,
  redirectUrl,
}: {
  connectedGitHubRepo: ConnectedGitHubRepo;
  previewEnvironmentEnabled?: boolean;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  billingPath: string;
  redirectUrl?: string;
}) {
  const lastSubmission = useActionData() as any;
  const navigation = useNavigation();

  const [hasGitSettingsChanges, setHasGitSettingsChanges] = useState(false);
  const [gitSettingsValues, setGitSettingsValues] = useState({
    productionBranch: connectedGitHubRepo.branchTracking?.prod?.branch || "",
    stagingBranch: connectedGitHubRepo.branchTracking?.staging?.branch || "",
    previewDeploymentsEnabled: connectedGitHubRepo.previewDeploymentsEnabled,
  });

  useEffect(() => {
    const hasChanges =
      gitSettingsValues.productionBranch !==
        (connectedGitHubRepo.branchTracking?.prod?.branch || "") ||
      gitSettingsValues.stagingBranch !==
        (connectedGitHubRepo.branchTracking?.staging?.branch || "") ||
      gitSettingsValues.previewDeploymentsEnabled !== connectedGitHubRepo.previewDeploymentsEnabled;
    setHasGitSettingsChanges(hasChanges);
  }, [gitSettingsValues, connectedGitHubRepo]);

  const [gitSettingsForm, fields] = useForm({
    id: "update-git-settings",
    lastSubmission: lastSubmission,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: UpdateGitSettingsFormSchema,
      });
    },
  });

  const isGitSettingsLoading =
    navigation.formData?.get("action") === "update-git-settings" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const actionUrl = gitHubResourcePath(organizationSlug, projectSlug, environmentSlug);

  return (
    <>
      <div className="mb-4 flex items-center justify-between rounded-sm border bg-grid-dimmed p-2">
        <div className="flex items-center gap-2">
          <OctoKitty className="size-4" />
          <a
            href={connectedGitHubRepo.repository.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="max-w-52 truncate text-sm text-text-bright hover:underline"
          >
            {connectedGitHubRepo.repository.fullName}
          </a>
          {connectedGitHubRepo.repository.private && (
            <LockClosedIcon className="size-3 text-text-dimmed" />
          )}
          <span className="text-xs text-text-dimmed">
            <DateTime
              date={connectedGitHubRepo.createdAt}
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
            <DialogHeader>Disconnect GitHub repository</DialogHeader>
            <div className="flex flex-col gap-3 pt-3">
              <Paragraph className="mb-1">
                Are you sure you want to disconnect{" "}
                <span className="font-semibold">{connectedGitHubRepo.repository.fullName}</span>?
                This will stop automatic deployments from GitHub.
              </Paragraph>
              <FormButtons
                confirmButton={
                  <Form method="post" action={actionUrl}>
                    <input type="hidden" name="action" value="disconnect-repo" />
                    {redirectUrl && <input type="hidden" name="redirectUrl" value={redirectUrl} />}
                    <Button type="submit" variant="danger/medium">
                      Disconnect repository
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

      <Form method="post" action={actionUrl} {...gitSettingsForm.props}>
        {redirectUrl && <input type="hidden" name="redirectUrl" value={redirectUrl} />}
        <Fieldset>
          <InputGroup fullWidth>
            <Hint>
              Every push to the selected tracking branch creates a deployment in the corresponding
              environment.
            </Hint>
            <div className="mt-1 grid grid-cols-[120px_1fr] gap-3">
              <div className="flex items-center gap-1.5">
                <EnvironmentIcon environment={{ type: "PRODUCTION" }} className="size-4" />
                <span className={`text-sm ${environmentTextClassName({ type: "PRODUCTION" })}`}>
                  {environmentFullTitle({ type: "PRODUCTION" })}
                </span>
              </div>
              <Input
                {...conform.input(fields.productionBranch, { type: "text" })}
                defaultValue={connectedGitHubRepo.branchTracking?.prod?.branch}
                placeholder="none"
                variant="tertiary"
                className="font-mono"
                icon={GitBranchIcon}
                onChange={(e) => {
                  setGitSettingsValues((prev) => ({
                    ...prev,
                    productionBranch: e.target.value,
                  }));
                }}
              />
              <div className="flex items-center gap-1.5">
                <EnvironmentIcon environment={{ type: "STAGING" }} className="size-4" />
                <span className={`text-sm ${environmentTextClassName({ type: "STAGING" })}`}>
                  {environmentFullTitle({ type: "STAGING" })}
                </span>
              </div>
              <Input
                {...conform.input(fields.stagingBranch, { type: "text" })}
                defaultValue={connectedGitHubRepo.branchTracking?.staging?.branch}
                placeholder="none"
                variant="tertiary"
                className="font-mono"
                icon={GitBranchIcon}
                onChange={(e) => {
                  setGitSettingsValues((prev) => ({
                    ...prev,
                    stagingBranch: e.target.value,
                  }));
                }}
              />

              <div className="flex items-center gap-1.5">
                <EnvironmentIcon environment={{ type: "PREVIEW" }} className="size-4" />
                <span className={`text-sm ${environmentTextClassName({ type: "PREVIEW" })}`}>
                  {environmentFullTitle({ type: "PREVIEW" })}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch
                  name="previewDeploymentsEnabled"
                  disabled={!previewEnvironmentEnabled}
                  defaultChecked={
                    connectedGitHubRepo.previewDeploymentsEnabled && previewEnvironmentEnabled
                  }
                  variant="small"
                  label="Create preview deployments for pull requests"
                  labelPosition="right"
                  onCheckedChange={(checked) => {
                    setGitSettingsValues((prev) => ({
                      ...prev,
                      previewDeploymentsEnabled: checked,
                    }));
                  }}
                />
                {!previewEnvironmentEnabled && (
                  <InfoIconTooltip
                    content={
                      <span className="text-xs">
                        <TextLink to={billingPath}>Upgrade</TextLink> your plan to enable preview
                        branches
                      </span>
                    }
                  />
                )}
              </div>
            </div>
            <FormError>{fields.productionBranch?.error}</FormError>
            <FormError>{fields.stagingBranch?.error}</FormError>
            <FormError>{fields.previewDeploymentsEnabled?.error}</FormError>
            <FormError>{gitSettingsForm.error}</FormError>
          </InputGroup>

          <FormButtons
            confirmButton={
              <Button
                type="submit"
                name="action"
                value="update-git-settings"
                variant="secondary/small"
                disabled={isGitSettingsLoading || !hasGitSettingsChanges}
                LeadingIcon={isGitSettingsLoading ? SpinnerWhite : undefined}
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
// Main GitHub Settings Panel Component
// ============================================================================

export function GitHubSettingsPanel({
  organizationSlug,
  projectSlug,
  environmentSlug,
  billingPath,
}: {
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  billingPath: string;
}) {
  const fetcher = useTypedFetcher<typeof loader>();
  const location = useLocation();

  // Use provided redirectUrl or fall back to current path (without search params)
  const effectiveRedirectUrl = location.pathname;
  useEffect(() => {
    fetcher.load(gitHubResourcePath(organizationSlug, projectSlug, environmentSlug));
  }, [organizationSlug, projectSlug, environmentSlug]);

  const data = fetcher.data;

  // Loading state
  if (fetcher.state === "loading" && !data) {
    return (
      <div className="flex items-center gap-2 text-text-dimmed">
        <SpinnerWhite className="size-4" />
        <span className="text-sm">Loading GitHub settings...</span>
      </div>
    );
  }

  // GitHub app not enabled
  if (!data || !data.enabled) {
    return null;
  }

  // Connected repository exists - show form
  if (data.connectedRepository) {
    return (
      <ConnectedGitHubRepoForm
        connectedGitHubRepo={data.connectedRepository}
        previewEnvironmentEnabled={data.isPreviewEnvironmentEnabled}
        organizationSlug={organizationSlug}
        projectSlug={projectSlug}
        environmentSlug={environmentSlug}
        billingPath={billingPath}
        redirectUrl={effectiveRedirectUrl}
      />
    );
  }

  // No connected repository - show connection prompt
  return (
    <div className="flex flex-col gap-2">
      <GitHubConnectionPrompt
        gitHubAppInstallations={data.installations ?? []}
        organizationSlug={organizationSlug}
        projectSlug={projectSlug}
        environmentSlug={environmentSlug}
        redirectUrl={effectiveRedirectUrl}
      />
      {!data.connectedRepository && (
        <Hint>
          Connect your GitHub repository to automatically deploy your changes.
        </Hint>
      )}
    </div>
    
  );
}
