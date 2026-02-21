import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { CommandLineIcon, FolderIcon } from "@heroicons/react/20/solid";
import { json, type ActionFunction, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import type { Prisma } from "@trigger.dev/database";
import React, { useEffect, useState } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { Feedback } from "~/components/Feedback";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { TechnologyPicker } from "~/components/onboarding/TechnologyPicker";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Select, SelectItem } from "~/components/primitives/Select";
import { ButtonSpinner } from "~/components/primitives/Spinner";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { createProject, ExceededProjectLimitError } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import {
  newProjectPath,
  OrganizationParamsSchema,
  organizationPath,
  selectPlanPath,
  v3ProjectPath,
} from "~/utils/pathBuilder";
import { generateVercelOAuthState } from "~/v3/vercel/vercelOAuthState.server";

const workingOnOptions = [
  "AI agent",
  "Media processing pipeline",
  "Media generation with AI",
  "Event-driven workflow",
  "Realtime streaming",
  "Internal tool or background job",
  "Other/not sure yet",
] as const;

const goalOptions = [
  "Ship a production workflow",
  "Prototype or explore",
  "Migrate an existing system",
  "Learn how Trigger works",
  "Evaluate against alternatives",
] as const;

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function MultiSelectField({
  value,
  setValue,
  items,
  icon,
}: {
  value: string[];
  setValue: (value: string[]) => void;
  items: string[];
  icon: React.ReactNode;
}) {
  return (
    <Select<string[], string>
      value={value}
      setValue={setValue}
      placeholder="Select options"
      variant="secondary/small"
      dropdownIcon
      icon={icon}
      items={items}
      className="h-8 min-w-0 border-0 bg-charcoal-750 pl-2 text-sm text-text-dimmed ring-charcoal-600 transition hover:bg-charcoal-650 hover:text-text-dimmed hover:ring-1"
      text={(v) =>
        v.length === 0 ? undefined : (
          <span className="flex min-w-0 items-center text-text-bright">
            <span className="truncate">{v.slice(0, 2).join(", ")}</span>
            {v.length > 2 && <span className="ml-1 flex-none">+{v.length - 2} more</span>}
          </span>
        )
      }
    >
      {(items) =>
        items.map((item) => (
          <SelectItem key={item} value={item} checkPosition="left">
            <span className="text-text-bright">{item}</span>
          </SelectItem>
        ))
      }
    </Select>
  );
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
    select: {
      id: true,
      title: true,
      v3Enabled: true,
      v2Enabled: true,
      hasRequestedV3: true,
      _count: {
        select: {
          projects: {
            where: {
              deletedAt: null,
            },
          },
        },
      },
    },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const { isManagedCloud } = featuresForRequest(request);
  if (isManagedCloud && !organization.v3Enabled) {
    return redirect(selectPlanPath({ slug: organizationSlug }));
  }

  const url = new URL(request.url);
  const message = url.searchParams.get("message");

  return typedjson({
    organization: {
      id: organization.id,
      title: organization.title,
      slug: organizationSlug,
      projectsCount: organization._count.projects,
      v3Enabled: organization.v3Enabled,
      v2Enabled: organization.v2Enabled,
      hasRequestedV3: organization.hasRequestedV3,
    },
    defaultVersion: url.searchParams.get("version") ?? "v2",
    message: message ? decodeURIComponent(message) : undefined,
  });
}

const schema = z.object({
  projectName: z.string().min(3, "Project name must have at least 3 characters").max(50),
  projectVersion: z.enum(["v2", "v3"]),
  workingOn: z.string().optional(),
  workingOnOther: z.string().optional(),
  technologies: z.string().optional(),
  technologiesOther: z.string().optional(),
  goals: z.string().optional(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const configurationId = url.searchParams.get("configurationId");
  const next = url.searchParams.get("next");

  const onboardingData: Record<string, Prisma.InputJsonValue> = {};

  if (submission.value.workingOn) {
    const workingOn = JSON.parse(submission.value.workingOn) as string[];
    if (workingOn.length > 0) {
      onboardingData.workingOn = workingOn;
    }
  }
  if (submission.value.workingOnOther) {
    onboardingData.workingOnOther = submission.value.workingOnOther;
  }
  if (submission.value.technologies) {
    const technologies = JSON.parse(submission.value.technologies) as string[];
    if (technologies.length > 0) {
      onboardingData.technologies = technologies;
    }
  }
  if (submission.value.technologiesOther) {
    const technologiesOther = JSON.parse(submission.value.technologiesOther) as string[];
    if (technologiesOther.length > 0) {
      onboardingData.technologiesOther = technologiesOther;
    }
  }
  if (submission.value.goals) {
    const goals = JSON.parse(submission.value.goals) as string[];
    if (goals.length > 0) {
      onboardingData.goals = goals;
    }
  }

  try {
    const project = await createProject({
      organizationSlug: organizationSlug,
      name: submission.value.projectName,
      userId,
      version: submission.value.projectVersion,
      onboardingData: Object.keys(onboardingData).length > 0 ? onboardingData : undefined,
    });

    if (code && configurationId) {
      const environment = await prisma.runtimeEnvironment.findFirst({
        where: {
          projectId: project.id,
          slug: "prod",
          archivedAt: null,
        },
      });

      if (!environment) {
        return redirectWithErrorMessage(
          newProjectPath({ slug: organizationSlug }),
          request,
          "Failed to find project environment."
        );
      }

      const state = await generateVercelOAuthState({
        organizationId: project.organization.id,
        projectId: project.id,
        environmentSlug: environment.slug,
        organizationSlug: project.organization.slug,
        projectSlug: project.slug,
      });

      const params = new URLSearchParams({
        state,
        code,
        configurationId,
        origin: "marketplace",
      });
      if (next) {
        params.set("next", next);
      }
      return redirect(`/vercel/connect?${params.toString()}`);
    }

    return redirectWithSuccessMessage(
      v3ProjectPath(project.organization, project),
      request,
      `${submission.value.projectName} created`
    );
  } catch (error) {
    if (error instanceof ExceededProjectLimitError) {
      return redirectWithErrorMessage(
        newProjectPath({ slug: organizationSlug }),
        request,
        error.message,
        {
          title: "Failed to create project",
          action: {
            label: "Request more projects",
            variant: "secondary/small",
            action: { type: "help", feedbackType: "help" },
          },
        }
      );
    }

    return redirectWithErrorMessage(
      newProjectPath({ slug: organizationSlug }),
      request,
      error instanceof Error ? error.message : "Something went wrong",
      { ephemeral: false }
    );
  }
};

export default function Page() {
  const { organization, message } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();

  const canCreateV3Projects = organization.v3Enabled;

  const [form, { projectName, projectVersion }] = useForm({
    id: "create-project",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

  const [selectedWorkingOn, setSelectedWorkingOn] = useState<string[]>([]);
  const [workingOnOther, setWorkingOnOther] = useState("");
  const [selectedTechnologies, setSelectedTechnologies] = useState<string[]>([]);
  const [customTechnologies, setCustomTechnologies] = useState<string[]>([]);
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);

  const [shuffledWorkingOn, setShuffledWorkingOn] = useState<string[]>([...workingOnOptions]);

  useEffect(() => {
    const nonOther = workingOnOptions.filter((o) => o !== "Other/not sure yet");
    setShuffledWorkingOn([...shuffleArray(nonOther), "Other/not sure yet"]);
  }, []);

  const showWorkingOnOther = selectedWorkingOn.includes("Other/not sure yet");

  return (
    <AppContainer className="bg-charcoal-900">
      <BackgroundWrapper>
        <MainCenteredContainer className="max-w-[29rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
          <div>
            <FormTitle
              LeadingIcon={<FolderIcon className="size-7 text-indigo-500" />}
              title="Create a new project"
              description={`This will create a new project in your "${organization.title}" organization.`}
            />
            <Form method="post" {...form.props}>
              {message && (
                <Callout variant="success" className="mb-4">
                  {message}
                </Callout>
              )}
              <Fieldset>
                <InputGroup>
                  <Label htmlFor={projectName.id}>
                    Project name <span className="text-text-bright">*</span>
                  </Label>
                  <Input
                    {...conform.input(projectName, { type: "text" })}
                    placeholder="Your project name"
                    icon={FolderIcon}
                    autoFocus
                  />
                  <FormError id={projectName.errorId}>{projectName.error}</FormError>
                </InputGroup>
                {canCreateV3Projects ? (
                  <input {...conform.input(projectVersion, { type: "hidden" })} value={"v3"} />
                ) : (
                  <input {...conform.input(projectVersion, { type: "hidden" })} value={"v2"} />
                )}

                <div className="border-t border-charcoal-700" />
                <InputGroup>
                  <Label>What are you working on?</Label>
                  <input type="hidden" name="workingOn" value={JSON.stringify(selectedWorkingOn)} />
                  <MultiSelectField
                    value={selectedWorkingOn}
                    setValue={setSelectedWorkingOn}
                    items={shuffledWorkingOn}
                    icon={<CommandLineIcon className="mr-1 size-4 text-text-dimmed" />}
                  />
                  {showWorkingOnOther && (
                    <>
                      <input type="hidden" name="workingOnOther" value={workingOnOther} />
                      <Input
                        type="text"
                        variant="small"
                        value={workingOnOther}
                        onChange={(e) => setWorkingOnOther(e.target.value)}
                        placeholder="Tell us what you're working on"
                        spellCheck={false}
                        containerClassName="h-8"
                      />
                    </>
                  )}
                </InputGroup>

                <InputGroup>
                  <Label>What technologies are you using?</Label>
                  <input
                    type="hidden"
                    name="technologies"
                    value={JSON.stringify(selectedTechnologies)}
                  />
                  <input
                    type="hidden"
                    name="technologiesOther"
                    value={JSON.stringify(customTechnologies)}
                  />
                  <TechnologyPicker
                    value={selectedTechnologies}
                    onChange={setSelectedTechnologies}
                    customValues={customTechnologies}
                    onCustomValuesChange={setCustomTechnologies}
                  />
                </InputGroup>

                <InputGroup>
                  <Label>What are you trying to do with Trigger.dev?</Label>
                  <input type="hidden" name="goals" value={JSON.stringify(selectedGoals)} />
                  <MultiSelectField
                    value={selectedGoals}
                    setValue={setSelectedGoals}
                    items={[...goalOptions]}
                    icon={<CommandLineIcon className="mr-1 size-4 text-text-dimmed" />}
                  />
                </InputGroup>

                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant={"primary/small"}
                      disabled={isLoading}
                      TrailingIcon={isLoading ? ButtonSpinner : undefined}
                    >
                      {isLoading ? "Creating…" : "Create"}
                    </Button>
                  }
                  cancelButton={
                    organization.projectsCount > 0 ? (
                      <LinkButton to={organizationPath(organization)} variant={"secondary/small"}>
                        Cancel
                      </LinkButton>
                    ) : undefined
                  }
                />
              </Fieldset>
            </Form>
          </div>
          <Feedback button={<></>} />
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}
