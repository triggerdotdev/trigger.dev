import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  TrashIcon,
  LockClosedIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import {
  Form,
  type MetaFunction,
  useActionData,
  useNavigation,
  useNavigate,
} from "@remix-run/react";
import { type ActionFunction, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { DialogClose } from "@radix-ui/react-dialog";
import { OctoKitty } from "~/components/GitHubLoginButton";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  redirectBackWithErrorMessage,
  redirectBackWithSuccessMessage,
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
  getSession,
  commitSession,
} from "~/models/message.server";
import { ProjectSettingsService } from "~/services/projectSettings.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import {
  organizationPath,
  v3ProjectPath,
  githubAppInstallPath,
  EnvironmentParamSchema,
  v3ProjectSettingsPath,
} from "~/utils/pathBuilder";
import { useEffect, useState } from "react";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Switch } from "~/components/primitives/Switch";
import { type BranchTrackingConfig } from "~/v3/github";
import {
  EnvironmentIcon,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { GitBranchIcon } from "lucide-react";
import { useEnvironment } from "~/hooks/useEnvironment";
import { DateTime } from "~/components/primitives/DateTime";
import { TextLink } from "~/components/primitives/TextLink";
import { cn } from "~/utils/cn";
import { ProjectSettingsPresenter } from "~/services/projectSettingsPresenter.server";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Project settings | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = EnvironmentParamSchema.parse(params);

  const projectSettingsPresenter = new ProjectSettingsPresenter();
  const resultOrFail = await projectSettingsPresenter.getProjectSettings(
    organizationSlug,
    projectParam,
    userId
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

  const { gitHubApp } = resultOrFail.value;

  const session = await getSession(request.headers.get("Cookie"));
  const openGitHubRepoConnectionModal = session.get("gitHubAppInstalled") === true;
  const headers = new Headers({
    "Set-Cookie": await commitSession(session),
  });

  return typedjson(
    {
      githubAppEnabled: gitHubApp.enabled,
      githubAppInstallations: gitHubApp.installations,
      connectedGithubRepository: gitHubApp.connectedRepository,
      openGitHubRepoConnectionModal,
    },
    { headers }
  );
};

const ConnectGitHubRepoFormSchema = z.object({
  action: z.literal("connect-repo"),
  installationId: z.string(),
  repositoryId: z.string(),
});

const UpdateGitSettingsFormSchema = z.object({
  action: z.literal("update-git-settings"),
  productionBranch: z.string().trim().optional(),
  stagingBranch: z.string().trim().optional(),
  previewDeploymentsEnabled: z
    .string()
    .optional()
    .transform((val) => val === "on"),
});

export function createSchema(
  constraints: {
    getSlugMatch?: (slug: string) => { isMatch: boolean; projectSlug: string };
  } = {}
) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("rename"),
      projectName: z.string().min(3, "Project name must have at least 3 characters").max(50),
    }),
    z.object({
      action: z.literal("delete"),
      projectSlug: z.string().superRefine((slug, ctx) => {
        if (constraints.getSlugMatch === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: conform.VALIDATION_UNDEFINED,
          });
        } else {
          const { isMatch, projectSlug } = constraints.getSlugMatch(slug);
          if (isMatch) {
            return;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `The slug must match ${projectSlug}`,
          });
        }
      }),
    }),
    ConnectGitHubRepoFormSchema,
    UpdateGitSettingsFormSchema,
    z.object({
      action: z.literal("disconnect-repo"),
    }),
  ]);
}

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = params;
  if (!organizationSlug || !projectParam) {
    return json({ errors: { body: "organizationSlug is required" } }, { status: 400 });
  }

  const formData = await request.formData();

  const schema = createSchema({
    getSlugMatch: (slug) => {
      return { isMatch: slug === projectParam, projectSlug: projectParam };
    },
  });
  const submission = parse(formData, { schema });

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

  switch (submission.value.action) {
    case "rename": {
      const resultOrFail = await projectSettingsService.renameProject(
        projectId,
        submission.value.projectName
      );

      if (resultOrFail.isErr()) {
        switch (resultOrFail.error.type) {
          case "other":
          default: {
            resultOrFail.error.type satisfies "other";

            logger.error("Failed to rename project", {
              error: resultOrFail.error,
            });
            return json({ errors: { body: "Failed to rename project" } }, { status: 400 });
          }
        }
      }

      return redirectWithSuccessMessage(
        v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
        request,
        `Project renamed to ${submission.value.projectName}`
      );
    }
    case "delete": {
      const resultOrFail = await projectSettingsService.deleteProject(projectParam, userId);

      if (resultOrFail.isErr()) {
        switch (resultOrFail.error.type) {
          case "other":
          default: {
            resultOrFail.error.type satisfies "other";

            logger.error("Failed to delete project", {
              error: resultOrFail.error,
            });
            return redirectWithErrorMessage(
              v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
              request,
              `Project ${projectParam} could not be deleted`
            );
          }
        }
      }

      return redirectWithSuccessMessage(
        organizationPath({ slug: organizationSlug }),
        request,
        "Project deleted"
      );
    }
    case "disconnect-repo": {
      const resultOrFail = await projectSettingsService.disconnectGitHubRepo(projectId);

      if (resultOrFail.isErr()) {
        switch (resultOrFail.error.type) {
          case "other":
          default: {
            resultOrFail.error.type satisfies "other";

            logger.error("Failed to disconnect GitHub repository", {
              error: resultOrFail.error,
            });
            return redirectBackWithErrorMessage(request, "Failed to disconnect GitHub repository");
          }
        }
      }

      return redirectBackWithSuccessMessage(request, "GitHub repository disconnected successfully");
    }
    case "update-git-settings": {
      const { productionBranch, stagingBranch, previewDeploymentsEnabled } = submission.value;

      const resultOrFail = await projectSettingsService.updateGitSettings(
        projectId,
        productionBranch,
        stagingBranch,
        previewDeploymentsEnabled
      );

      if (resultOrFail.isErr()) {
        switch (resultOrFail.error.type) {
          case "github_app_not_enabled": {
            return redirectBackWithErrorMessage(request, "GitHub app is not enabled");
          }
          case "connected_gh_repository_not_found": {
            return redirectBackWithErrorMessage(request, "Connected GitHub repository not found");
          }
          case "production_tracking_branch_not_found": {
            return redirectBackWithErrorMessage(request, "Production tracking branch not found");
          }
          case "staging_tracking_branch_not_found": {
            return redirectBackWithErrorMessage(request, "Staging tracking branch not found");
          }
          case "other":
          default: {
            resultOrFail.error.type satisfies "other";

            logger.error("Failed to update Git settings", {
              error: resultOrFail.error,
            });
            return redirectBackWithErrorMessage(request, "Failed to update Git settings");
          }
        }
      }

      return redirectBackWithSuccessMessage(request, "Git settings updated successfully");
    }
    case "connect-repo": {
      const { repositoryId, installationId } = submission.value;

      const resultOrFail = await projectSettingsService.connectGitHubRepo(
        projectId,
        organizationId,
        repositoryId,
        installationId
      );

      if (resultOrFail.isErr()) {
        switch (resultOrFail.error.type) {
          case "gh_repository_not_found": {
            return redirectBackWithErrorMessage(request, "GitHub repository not found");
          }
          case "project_already_has_connected_repository": {
            return redirectBackWithErrorMessage(
              request,
              "Project already has a connected repository"
            );
          }
          case "other":
          default: {
            resultOrFail.error.type satisfies "other";

            logger.error("Failed to connect GitHub repository", {
              error: resultOrFail.error,
            });
            return redirectBackWithErrorMessage(request, "Failed to connect GitHub repository");
          }
        }
      }

      return json({
        ...submission,
        success: true,
      });
    }
    default: {
      submission.value satisfies never;
      return redirectBackWithErrorMessage(request, "Failed to process request");
    }
  }
};

export default function Page() {
  const {
    githubAppInstallations,
    connectedGithubRepository,
    githubAppEnabled,
    openGitHubRepoConnectionModal,
  } = useTypedLoaderData<typeof loader>();
  const project = useProject();
  const organization = useOrganization();
  const environment = useEnvironment();
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const [hasRenameFormChanges, setHasRenameFormChanges] = useState(false);

  const [renameForm, { projectName }] = useForm({
    id: "rename-project",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema(),
      });
    },
  });

  const isRenameLoading =
    navigation.formData?.get("action") === "rename" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const [deleteForm, { projectSlug }] = useForm({
    id: "delete-project",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldValidate: "onInput",
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: createSchema({
          getSlugMatch: (slug) => ({ isMatch: slug === project.slug, projectSlug: project.slug }),
        }),
      });
    },
  });

  const isDeleteLoading =
    navigation.formData?.get("action") === "delete" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  const [deleteInputValue, setDeleteInputValue] = useState("");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Project settings" />

        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>ID</Property.Label>
                <Property.Value>{project.id}</Property.Value>
                <div className="flex items-center gap-2">
                  <Paragraph variant="extra-small/bright/mono">{project.id}</Paragraph>
                </div>
              </Property.Item>
              <Property.Item>
                <Property.Label>Org ID</Property.Label>
                <Property.Value>{project.organizationId}</Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>

      <PageBody>
        <MainHorizontallyCenteredContainer className="md:mt-6">
          <div className="flex flex-col gap-6">
            <div>
              <Header2 spacing>General</Header2>
              <div className="w-full rounded-sm border border-grid-dimmed p-4">
                <Fieldset className="mb-5">
                  <InputGroup fullWidth>
                    <Label>Project ref</Label>
                    <ClipboardField value={project.externalRef} variant={"secondary/medium"} />
                    <Hint>
                      This goes in your{" "}
                      <InlineCode variant="extra-extra-small">trigger.config</InlineCode> file.
                    </Hint>
                  </InputGroup>
                </Fieldset>
                <Form method="post" {...renameForm.props}>
                  <Fieldset>
                    <InputGroup fullWidth>
                      <Label htmlFor={projectName.id}>Project name</Label>
                      <Input
                        {...conform.input(projectName, { type: "text" })}
                        defaultValue={project.name}
                        placeholder="Project name"
                        icon={FolderIcon}
                        autoFocus
                        onChange={(e) => {
                          setHasRenameFormChanges(e.target.value !== project.name);
                        }}
                      />
                      <FormError id={projectName.errorId}>{projectName.error}</FormError>
                    </InputGroup>
                    <FormButtons
                      confirmButton={
                        <Button
                          type="submit"
                          name="action"
                          value="rename"
                          variant={"secondary/small"}
                          disabled={isRenameLoading || !hasRenameFormChanges}
                          LeadingIcon={isRenameLoading ? SpinnerWhite : undefined}
                        >
                          Save
                        </Button>
                      }
                    />
                  </Fieldset>
                </Form>
              </div>
            </div>

            {githubAppEnabled && (
              <div>
                <Header2 spacing>Git settings</Header2>
                <div className="w-full rounded-sm border border-grid-dimmed p-4">
                  {connectedGithubRepository ? (
                    <ConnectedGitHubRepoForm connectedGitHubRepo={connectedGithubRepository} />
                  ) : (
                    <GitHubConnectionPrompt
                      gitHubAppInstallations={githubAppInstallations ?? []}
                      organizationSlug={organization.slug}
                      projectSlug={project.slug}
                      environmentSlug={environment.slug}
                      openGitHubRepoConnectionModal={openGitHubRepoConnectionModal}
                    />
                  )}
                </div>
              </div>
            )}

            <div>
              <Header2 spacing>Danger zone</Header2>
              <div className="w-full rounded-sm border border-rose-500/40 p-4">
                <Form method="post" {...deleteForm.props}>
                  <Fieldset>
                    <InputGroup fullWidth>
                      <Label htmlFor={projectSlug.id}>Delete project</Label>
                      <Input
                        {...conform.input(projectSlug, { type: "text" })}
                        placeholder="Your project slug"
                        icon={ExclamationTriangleIcon}
                        onChange={(e) => setDeleteInputValue(e.target.value)}
                      />
                      <FormError id={projectSlug.errorId}>{projectSlug.error}</FormError>
                      <FormError>{deleteForm.error}</FormError>
                      <Hint>
                        This change is irreversible, so please be certain. Type in the Project slug
                        <InlineCode variant="extra-small">{project.slug}</InlineCode> and then press
                        Delete.
                      </Hint>
                    </InputGroup>
                    <FormButtons
                      confirmButton={
                        <Button
                          type="submit"
                          name="action"
                          value="delete"
                          variant={"danger/small"}
                          LeadingIcon={isDeleteLoading ? SpinnerWhite : TrashIcon}
                          leadingIconClassName="text-white"
                          disabled={isDeleteLoading || deleteInputValue !== project.slug}
                        >
                          Delete
                        </Button>
                      }
                    />
                  </Fieldset>
                </Form>
              </div>
            </div>
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

type GitHubRepository = {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
};

type GitHubAppInstallation = {
  id: string;
  appInstallationId: bigint;
  targetType: string;
  accountHandle: string;
  repositories: GitHubRepository[];
};

function ConnectGitHubRepoModal({
  gitHubAppInstallations,
  organizationSlug,
  projectSlug,
  environmentSlug,
  open = false,
}: {
  gitHubAppInstallations: GitHubAppInstallation[];
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  open?: boolean;
}) {
  const [isModalOpen, setIsModalOpen] = useState(open);
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

  useEffect(() => {
    if (lastSubmission && "success" in lastSubmission && lastSubmission.success === true) {
      setIsModalOpen(false);
    }
  }, [lastSubmission]);

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
          <Form method="post" {...form.props} className="w-full">
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
                            v3ProjectSettingsPath(
                              { slug: organizationSlug },
                              { slug: projectSlug },
                              { slug: environmentSlug }
                            )
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

function GitHubConnectionPrompt({
  gitHubAppInstallations,
  organizationSlug,
  projectSlug,
  environmentSlug,
  openGitHubRepoConnectionModal = false,
}: {
  gitHubAppInstallations: GitHubAppInstallation[];
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  openGitHubRepoConnectionModal?: boolean;
}) {
  return (
    <Fieldset>
      <InputGroup fullWidth>
        {gitHubAppInstallations.length === 0 && (
          <LinkButton
            to={githubAppInstallPath(
              organizationSlug,
              v3ProjectSettingsPath(
                { slug: organizationSlug },
                { slug: projectSlug },
                { slug: environmentSlug }
              )
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
              open={openGitHubRepoConnectionModal}
            />
            <span className="flex items-center gap-1 text-xs text-text-dimmed">
              <CheckCircleIcon className="size-4 text-success" /> GitHub app is installed
            </span>
          </div>
        )}

        <Hint>Connect your GitHub repository to automatically deploy your changes.</Hint>
      </InputGroup>
    </Fieldset>
  );
}

type ConnectedGitHubRepo = {
  branchTracking: BranchTrackingConfig | undefined;
  previewDeploymentsEnabled: boolean;
  createdAt: Date;
  repository: GitHubRepository;
};

function ConnectedGitHubRepoForm({
  connectedGitHubRepo,
}: {
  connectedGitHubRepo: ConnectedGitHubRepo;
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
                  <Form method="post">
                    <input type="hidden" name="action" value="disconnect-repo" />
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

      <Form method="post" {...gitSettingsForm.props}>
        <Fieldset>
          <InputGroup fullWidth>
            <Hint>
              Every commit on the selected tracking branch creates a deployment in the corresponding
              environment.
            </Hint>
            <div className="grid grid-cols-[120px_1fr] gap-3">
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
              <Switch
                name="previewDeploymentsEnabled"
                defaultChecked={connectedGitHubRepo.previewDeploymentsEnabled}
                variant="small"
                label="create preview deployments for pull requests"
                labelPosition="right"
                onCheckedChange={(checked) => {
                  setGitSettingsValues((prev) => ({
                    ...prev,
                    previewDeploymentsEnabled: checked,
                  }));
                }}
              />
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
