import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { type ActionFunction, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData, useTypedFetcher } from "remix-typedjson";
import { z } from "zod";
import { MainHorizontallyCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import {
  redirectBackWithErrorMessage,
  redirectBackWithSuccessMessage,
} from "~/models/message.server";
import { ProjectSettingsService } from "~/services/projectSettings.server";
import { ProjectSettingsPresenter } from "~/services/projectSettingsPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3BillingPath, vercelResourcePath } from "~/utils/pathBuilder";
import React, { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "@remix-run/react";
import { type BuildSettings } from "~/v3/buildSettings";
import { GitHubSettingsPanel } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github";
import {
  VercelSettingsPanel,
  VercelOnboardingModal,
} from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.vercel";
import type { loader as vercelLoader } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.vercel";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";

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

  const { gitHubApp, buildSettings } = resultOrFail.value;

  return typedjson({
    githubAppEnabled: gitHubApp.enabled,
    buildSettings,
    vercelIntegrationEnabled: OrgIntegrationRepository.isVercelSupported,
  });
};

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
  useNativeBuildServer: z
    .string()
    .optional()
    .transform((val) => val === "on"),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = params;
  if (!organizationSlug || !projectParam) {
    return json({ errors: { body: "organizationSlug is required" } }, { status: 400 });
  }

  const formData = await request.formData();
  const submission = parse(formData, { schema: UpdateBuildSettingsFormSchema });

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

  const { projectId } = membershipResultOrFail.value;

  const { installCommand, preBuildCommand, triggerConfigFilePath, useNativeBuildServer } =
    submission.value;

  const resultOrFail = await projectSettingsService.updateBuildSettings(projectId, {
    installCommand: installCommand || undefined,
    preBuildCommand: preBuildCommand || undefined,
    triggerConfigFilePath: triggerConfigFilePath || undefined,
    useNativeBuildServer: useNativeBuildServer,
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
};

export default function IntegrationsSettingsPage() {
  const { githubAppEnabled, buildSettings, vercelIntegrationEnabled } =
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
      if (vercelFetcher.data?.onboardingData && vercelFetcher.state === "idle") {
        // Data is loaded, ensure modal is open (query param takes precedence)
        if (!isModalOpen) {
          openVercelOnboarding();
        }
      } else if (vercelFetcher.state === "idle" && vercelFetcher.data === undefined) {
        // Load onboarding data
        vercelFetcher.load(
          `${vercelResourcePath(organization.slug, project.slug, environment.slug)}?vercelOnboarding=true`
        );
      }
    } else if (!hasQueryParam && isModalOpen) {
      // Query param removed but modal is open, close modal
      setIsModalOpen(false);
    }
  }, [hasQueryParam, vercelIntegrationEnabled, organization.slug, project.slug, environment.slug, vercelFetcher.data, vercelFetcher.state, isModalOpen, openVercelOnboarding]);

  // Ensure modal stays open when query param is present (even after data reloads)
  // This is a safeguard to prevent the modal from closing during form submissions
  useEffect(() => {
    if (hasQueryParam && !isModalOpen) {
      // Query param is present but modal is closed, open it
      // This ensures the modal stays open during the onboarding flow
      openVercelOnboarding();
    }
  }, [hasQueryParam, isModalOpen, openVercelOnboarding]);

  // When data finishes loading (from query param), ensure modal is open
  useEffect(() => {
    if (hasQueryParam && vercelFetcher.data?.onboardingData && vercelFetcher.state === "idle") {
      // Data loaded and query param is present, ensure modal is open
      if (!isModalOpen) {
        openVercelOnboarding();
      }
    }
  }, [hasQueryParam, vercelFetcher.data, vercelFetcher.state, isModalOpen, openVercelOnboarding]);

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

    if (vercelFetcher.data && vercelFetcher.data.onboardingData) {
      // Data already loaded, open modal immediately
      openVercelOnboarding();
    } else {
      // Need to load data first, mark that we're waiting for button click
      waitingForButtonClickRef.current = true;
      vercelFetcher.load(
        `${vercelResourcePath(organization.slug, project.slug, environment.slug)}?vercelOnboarding=true`
      );
    }
  }, [organization.slug, project.slug, environment.slug, vercelFetcher, setSearchParams, hasQueryParam, openVercelOnboarding]);

  // When data loads from button click, open modal
  useEffect(() => {
    if (waitingForButtonClickRef.current && vercelFetcher.data?.onboardingData && vercelFetcher.state === "idle") {
      // Data loaded from button click, open modal and ensure query param is present
      waitingForButtonClickRef.current = false;
      openVercelOnboarding();
    }
  }, [vercelFetcher.data, vercelFetcher.state, openVercelOnboarding]);

  return (
    <>
      <MainHorizontallyCenteredContainer className="md:mt-6">
        <div className="flex flex-col gap-6">
          {githubAppEnabled && (
            <React.Fragment>
              <div>
                <Header2 spacing>Git settings</Header2>
                <div className="w-full rounded-sm border border-grid-dimmed p-4">
                  <GitHubSettingsPanel
                    organizationSlug={organization.slug}
                    projectSlug={project.slug}
                    environmentSlug={environment.slug}
                    billingPath={v3BillingPath({ slug: organization.slug })}
                  />
                </div>
              </div>

              {vercelIntegrationEnabled && (
                <div>
                  <Header2 spacing>Vercel integration</Header2>
                  <div className="w-full rounded-sm border border-grid-dimmed p-4">
                    <VercelSettingsPanel
                      organizationSlug={organization.slug}
                      projectSlug={project.slug}
                      environmentSlug={environment.slug}
                      onOpenVercelModal={handleOpenVercelModal}
                      isLoadingVercelData={vercelFetcher.state === "loading" || vercelFetcher.state === "submitting"}
                    />
                  </div>
                </div>
              )}

              <div>
                <Header2 spacing>Build settings</Header2>
                <div className="w-full rounded-sm border border-grid-dimmed p-4">
                  <BuildSettingsForm buildSettings={buildSettings ?? {}} />
                </div>
              </div>
            </React.Fragment>
          )}
        </div>
      </MainHorizontallyCenteredContainer>

      {/* Vercel Onboarding Modal */}
      {vercelIntegrationEnabled && (
        <VercelOnboardingModal
          isOpen={isModalOpen}
          onClose={closeVercelOnboarding}
          onboardingData={vercelFetcher.data?.onboardingData ?? null}
          organizationSlug={organization.slug}
          projectSlug={project.slug}
          environmentSlug={environment.slug}
          hasStagingEnvironment={vercelFetcher.data?.hasStagingEnvironment ?? false}
          hasPreviewEnvironment={vercelFetcher.data?.hasPreviewEnvironment ?? false}
          hasOrgIntegration={vercelFetcher.data?.hasOrgIntegration ?? false}
          nextUrl={nextUrl ?? undefined}
          onDataReload={(vercelEnvironmentId) => {
            vercelFetcher.load(
              `${vercelResourcePath(organization.slug, project.slug, environment.slug)}?vercelOnboarding=true${
                vercelEnvironmentId ? `&vercelEnvironmentId=${vercelEnvironmentId}` : ""
              }`
            );
          }}
        />
      )}
    </>
  );
}

function BuildSettingsForm({ buildSettings }: { buildSettings: BuildSettings }) {
  const lastSubmission = useActionData() as any;
  const navigation = useNavigation();

  const [hasBuildSettingsChanges, setHasBuildSettingsChanges] = useState(false);
  const [buildSettingsValues, setBuildSettingsValues] = useState({
    preBuildCommand: buildSettings?.preBuildCommand || "",
    installCommand: buildSettings?.installCommand || "",
    triggerConfigFilePath: buildSettings?.triggerConfigFilePath || "",
    useNativeBuildServer: buildSettings?.useNativeBuildServer || false,
  });

  useEffect(() => {
    const hasChanges =
      buildSettingsValues.preBuildCommand !== (buildSettings?.preBuildCommand || "") ||
      buildSettingsValues.installCommand !== (buildSettings?.installCommand || "") ||
      buildSettingsValues.triggerConfigFilePath !== (buildSettings?.triggerConfigFilePath || "") ||
      buildSettingsValues.useNativeBuildServer !== (buildSettings?.useNativeBuildServer || false);
    setHasBuildSettingsChanges(hasChanges);
  }, [buildSettingsValues, buildSettings]);

  const [buildSettingsForm, fields] = useForm({
    id: "update-build-settings",
    lastSubmission: lastSubmission,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, {
        schema: UpdateBuildSettingsFormSchema,
      });
    },
  });

  const isBuildSettingsLoading =
    navigation.formData?.get("action") === "update-build-settings" &&
    (navigation.state === "submitting" || navigation.state === "loading");

  return (
    <Form method="post" {...buildSettingsForm.props}>
      <Fieldset>
        <InputGroup fullWidth>
          <Label htmlFor={fields.triggerConfigFilePath.id}>Trigger config file</Label>
          <Input
            {...conform.input(fields.triggerConfigFilePath, { type: "text" })}
            defaultValue={buildSettings?.triggerConfigFilePath || ""}
            placeholder="trigger.config.ts"
            onChange={(e) => {
              setBuildSettingsValues((prev) => ({
                ...prev,
                triggerConfigFilePath: e.target.value,
              }));
            }}
          />
          <Hint>
            Path to your Trigger configuration file, relative to the root directory of your repo.
          </Hint>
          <FormError id={fields.triggerConfigFilePath.errorId}>
            {fields.triggerConfigFilePath.error}
          </FormError>
        </InputGroup>

        <InputGroup fullWidth>
          <Label htmlFor={fields.installCommand.id}>Install command</Label>
          <Input
            {...conform.input(fields.installCommand, { type: "text" })}
            defaultValue={buildSettings?.installCommand || ""}
            placeholder="e.g., `npm install`, `pnpm install`, or `bun install`"
            onChange={(e) => {
              setBuildSettingsValues((prev) => ({
                ...prev,
                installCommand: e.target.value,
              }));
            }}
          />
          <Hint>
            Command to install your project dependencies. This will be run from the root directory
            of your repo. Auto-detected by default.
          </Hint>
          <FormError id={fields.installCommand.errorId}>{fields.installCommand.error}</FormError>
        </InputGroup>
        <InputGroup fullWidth>
          <Label htmlFor={fields.preBuildCommand.id}>Pre-build command</Label>
          <Input
            {...conform.input(fields.preBuildCommand, { type: "text" })}
            defaultValue={buildSettings?.preBuildCommand || ""}
            placeholder="e.g., `npm run prisma:generate`"
            onChange={(e) => {
              setBuildSettingsValues((prev) => ({
                ...prev,
                preBuildCommand: e.target.value,
              }));
            }}
          />
          <Hint>
            Any command that needs to run before we build and deploy your project. This will be run
            from the root directory of your repo.
          </Hint>
          <FormError id={fields.preBuildCommand.errorId}>{fields.preBuildCommand.error}</FormError>
        </InputGroup>
        <div className="border-t border-grid-dimmed pt-4">
          <InputGroup>
            <CheckboxWithLabel
              id={fields.useNativeBuildServer.id}
              {...conform.input(fields.useNativeBuildServer, { type: "checkbox" })}
              label="Use native build server"
              variant="simple/small"
              defaultChecked={buildSettings?.useNativeBuildServer || false}
              onChange={(isChecked) => {
                setBuildSettingsValues((prev) => ({
                  ...prev,
                  useNativeBuildServer: isChecked,
                }));
              }}
            />
            <Hint>
              Native build server builds do not rely on external build providers and will become the
              default in the future. Version 4.2.0 or newer is required.
            </Hint>
            <FormError id={fields.useNativeBuildServer.errorId}>
              {fields.useNativeBuildServer.error}
            </FormError>
          </InputGroup>
        </div>
        <FormError>{buildSettingsForm.error}</FormError>
        <FormButtons
          confirmButton={
            <Button
              type="submit"
              name="action"
              value="update-build-settings"
              variant="secondary/small"
              disabled={isBuildSettingsLoading || !hasBuildSettingsChanges}
              LeadingIcon={isBuildSettingsLoading ? SpinnerWhite : undefined}
            >
              Save
            </Button>
          }
        />
      </Fieldset>
    </Form>
  );
}
