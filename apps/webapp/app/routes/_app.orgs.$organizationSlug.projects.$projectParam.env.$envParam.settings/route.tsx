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
  useLocation,
  useNavigation,
  useNavigate,
} from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/router";
import { type ActionFunction, json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { DialogClose, DialogDescription } from "@radix-ui/react-dialog";
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
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import {
  organizationPath,
  v3ProjectPath,
  githubAppInstallPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";
import { useState } from "react";
import { Select, SelectItem } from "~/components/primitives/Select";

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

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const githubAppInstallations = await prisma.githubAppInstallation.findMany({
    where: {
      organizationId: project.organizationId,
      deletedAt: null,
      suspendedAt: null,
    },
    select: {
      id: true,
      accountHandle: true,
      targetType: true,
      repositories: {
        select: {
          id: true,
          name: true,
          private: true,
        },
        where: {
          removedAt: null,
        },
        // Most installations will only have a couple of repos so loading them here should be fine.
        // However, there might be outlier organizations so it's best to expose the installation repos
        // via a resource endpoint and filter on user input.
        take: 100,
      },
    },
    take: 20,
    orderBy: {
      createdAt: "desc",
    },
  });

  return typedjson({ githubAppInstallations });
};

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

  try {
    switch (submission.value.action) {
      case "rename": {
        await prisma.project.update({
          where: {
            slug: projectParam,
            organization: {
              members: {
                some: {
                  userId,
                },
              },
            },
          },
          data: {
            name: submission.value.projectName,
          },
        });

        return redirectWithSuccessMessage(
          v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
          request,
          `Project renamed to ${submission.value.projectName}`
        );
      }
      case "delete": {
        const deleteProjectService = new DeleteProjectService();
        try {
          await deleteProjectService.call({ projectSlug: projectParam, userId });

          return redirectWithSuccessMessage(
            organizationPath({ slug: organizationSlug }),
            request,
            "Project deleted"
          );
        } catch (error: unknown) {
          logger.error("Project could not be deleted", {
            error: error instanceof Error ? error.message : JSON.stringify(error),
          });
          return redirectWithErrorMessage(
            v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
            request,
            `Project ${projectParam} could not be deleted`
          );
        }
      }
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const { githubAppInstallations } = useTypedLoaderData<typeof loader>();
  const project = useProject();
  const organization = useOrganization();
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const location = useLocation();

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
                          disabled={isRenameLoading}
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

            <div>
              <Header2 spacing>Git settings</Header2>
              <div className="w-full rounded-sm border border-grid-dimmed p-4">
                <Fieldset>
                  <InputGroup fullWidth>
                    {githubAppInstallations.length === 0 && (
                      <LinkButton
                        to={githubAppInstallPath(organization.slug, location.pathname)}
                        variant={"secondary/medium"}
                        LeadingIcon={OctoKitty}
                      >
                        Install GitHub App
                      </LinkButton>
                    )}
                    {githubAppInstallations.length !== 0 && (
                      <div className="flex items-center gap-3">
                        <ConnectGitHubRepoModal
                          gitHubAppInstallations={githubAppInstallations}
                          projectId={project.id}
                        />
                        <span className="flex items-center gap-1 text-xs text-text-dimmed">
                          <CheckCircleIcon className="size-4 text-success" /> GitHub app is
                          installed
                        </span>
                      </div>
                    )}

                    <Hint>
                      Connect your GitHub repository to automatically deploy your changes.
                    </Hint>
                  </InputGroup>
                </Fieldset>
              </div>
            </div>

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
                          disabled={isDeleteLoading}
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

const ConnectGitHubRepoFormSchema = z.object({
  installationId: z.string(),
  repositoryId: z.string(),
  projectId: z.string(),
});

type GitHubRepository = {
  id: string;
  name: string;
  private: boolean;
};

type GitHubAppInstallation = {
  id: string;
  targetType: string;
  accountHandle: string;
  repositories: GitHubRepository[];
};

function ConnectGitHubRepoModal({
  gitHubAppInstallations,
  projectId: triggerProjectId,
}: {
  gitHubAppInstallations: GitHubAppInstallation[];
  projectId: string;
}) {
  const [isModalOpen, setIsModalOpen] = useState(true);
  const lastSubmission = useActionData();
  const organization = useOrganization();
  const location = useLocation();
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

  const [form, { installationId, repositoryId, projectId }] = useForm({
    id: "connect-repo",
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: ConnectGitHubRepoFormSchema,
      });
    },
  });

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
            <input {...conform.input(projectId, { type: "hidden" })} value={triggerProjectId} />
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
                        navigate(githubAppInstallPath(organization.slug, location.pathname));
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
