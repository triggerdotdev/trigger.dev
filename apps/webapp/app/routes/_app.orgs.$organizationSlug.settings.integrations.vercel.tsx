import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import { DialogClose } from "@radix-ui/react-dialog";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { fromPromise } from "neverthrow";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ProjectConnectSelect } from "~/components/integrations/ProjectConnectSelect";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { $transaction, prisma } from "~/db.server";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { logger } from "~/services/logger.server";
import { requireOrganization } from "~/services/org.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { OrganizationParamsSchema, v3ProjectSettingsIntegrationsPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { useOrganization } from "~/hooks/useOrganizations";

export const meta = pageMeta("Vercel integration");

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const url = new URL(request.url);
  const configurationId = url.searchParams.get("configurationId") ?? undefined;
  const { organization, userId } = await requireOrganization(request, organizationSlug);

  // Display flag for the Remove Integration control — the action enforces
  // write:vercel independently. Permissive in OSS.
  const sessionAuth = await rbac.authenticateSession(request, {
    userId,
    organizationId: organization.id,
  });
  const canManageVercel = sessionAuth.ok
    ? sessionAuth.ability.can("write", { type: "vercel" })
    : true;

  // Find Vercel integration for this organization
  let vercelIntegration = await prisma.organizationIntegration.findFirst({
    where: {
      organizationId: organization.id,
      service: "VERCEL",
      deletedAt: null,
      // If configurationId is provided, filter by it in integrationData
      ...(configurationId && {
        integrationData: {
          path: ["installationId"],
          equals: configurationId,
        },
      }),
    },
    include: {
      tokenReference: true,
    },
  });

  if (!vercelIntegration) {
    return typedjson({
      organization,
      vercelIntegration: null,
      connectedProjects: [],
      teamId: null,
      installationId: null,
      canManageVercel,
    });
  }

  // Get team ID from integrationData
  const integrationData = vercelIntegration.integrationData as any;
  const teamId = integrationData?.teamId ?? null;
  const installationId = integrationData?.installationId ?? null;

  // Get all connected projects for this integration
  const connectedProjects = await prisma.organizationProjectIntegration.findMany({
    where: {
      organizationIntegrationId: vercelIntegration.id,
      deletedAt: null,
    },
    include: {
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return typedjson({
    organization,
    vercelIntegration,
    connectedProjects,
    teamId,
    installationId,
    canManageVercel,
  });
};

const ActionSchema = z.object({
  intent: z.literal("uninstall"),
});

export const action = dashboardAction(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: { action: "write", resource: { type: "vercel" } },
  },
  async ({ request, params }) => {
    const { organizationSlug } = params;
    const { organization, userId } = await requireOrganization(request, organizationSlug);

    const formData = await request.formData();
    const result = ActionSchema.safeParse({ intent: formData.get("intent") });
    if (!result.success) {
      return json({ error: "Invalid action" }, { status: 400 });
    }

    // Find Vercel integration
    const vercelIntegration = await prisma.organizationIntegration.findFirst({
      where: {
        organizationId: organization.id,
        service: "VERCEL",
        deletedAt: null,
      },
      include: {
        tokenReference: true,
      },
    });

    if (!vercelIntegration) {
      return json({ error: "Vercel integration not found" }, { status: 404 });
    }

    // Uninstall from Vercel side
    const uninstallResult =
      await VercelIntegrationRepository.uninstallVercelIntegration(vercelIntegration);

    if (uninstallResult.isErr()) {
      logger.error("Failed to uninstall Vercel integration", {
        organizationId: organization.id,
        organizationSlug,
        userId,
        integrationId: vercelIntegration.id,
        error: uninstallResult.error.message,
      });

      return json(
        { error: "Failed to uninstall Vercel integration. Please try again." },
        { status: 500 }
      );
    }

    // Soft-delete the integration and all connected projects in a transaction
    const txResult = await fromPromise(
      $transaction(prisma, async (tx) => {
        await tx.organizationProjectIntegration.updateMany({
          where: {
            organizationIntegrationId: vercelIntegration.id,
            deletedAt: null,
          },
          data: { deletedAt: new Date() },
        });

        await tx.organizationIntegration.update({
          where: { id: vercelIntegration.id },
          data: { deletedAt: new Date() },
        });
      }),
      (error) => error
    );

    if (txResult.isErr()) {
      logger.error("Failed to soft-delete Vercel integration records", {
        organizationId: organization.id,
        organizationSlug,
        userId,
        integrationId: vercelIntegration.id,
        error: txResult.error instanceof Error ? txResult.error.message : String(txResult.error),
      });

      return json(
        { error: "Failed to uninstall Vercel integration. Please try again." },
        { status: 500 }
      );
    }

    if (uninstallResult.value.authInvalid) {
      logger.warn("Vercel integration uninstalled with auth error - token invalid", {
        organizationId: organization.id,
        organizationSlug,
        userId,
        integrationId: vercelIntegration.id,
      });
    } else {
      logger.info("Vercel integration uninstalled successfully", {
        organizationId: organization.id,
        organizationSlug,
        userId,
        integrationId: vercelIntegration.id,
      });
    }

    // Redirect back to organization settings
    return redirect(`/orgs/${organizationSlug}/settings`);
  }
);

export default function VercelIntegrationPage() {
  const {
    organization,
    vercelIntegration,
    connectedProjects,
    teamId,
    installationId,
    canManageVercel,
  } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isUninstalling =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "uninstall";

  // The org context (parent loader) carries the project list for the connect CTA.
  const { projects } = useOrganization();

  if (!vercelIntegration) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Vercel integration" />
        </NavBar>
        <PageBody>
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <VercelLogo className="mb-2 size-16 text-secondary" />
            <Header2>No Vercel integration found</Header2>
            <Paragraph className="max-w-md text-center text-text-dimmed">
              Your organization doesn't have a Vercel integration. Configure it in your projects
              integrations page.
            </Paragraph>
            {projects.length > 0 ? (
              <ProjectConnectSelect
                projects={projects}
                configurePathFor={(project) =>
                  // Default to the production environment, matching the connected-state links.
                  v3ProjectSettingsIntegrationsPath(organization, project, { slug: "prod" })
                }
              />
            ) : null}
          </div>
        </PageBody>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Vercel integration" />
      </NavBar>
      <PageBody>
        <SettingsContainer>
          <SettingsSection>
            <SettingsHeader title="Overview" />
            {teamId ? (
              <SettingsRow
                title="Vercel team ID"
                action={
                  <CopyableText
                    value={teamId}
                    className="font-mono text-sm font-medium text-text-bright"
                  />
                }
              />
            ) : null}
            {installationId ? (
              <SettingsRow
                title="Installation ID"
                action={
                  <CopyableText
                    value={installationId}
                    className="font-mono text-sm font-medium text-text-bright"
                  />
                }
              />
            ) : null}
            <SettingsRow
              title="Installed"
              action={
                <span className="text-sm text-text-bright">
                  <DateTime date={vercelIntegration.createdAt} />
                </span>
              }
            />
            <SettingsRow
              title="Remove integration"
              align="end"
              action={
                <div className="flex flex-col items-end gap-1">
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button
                        variant="danger/small"
                        disabled={isUninstalling || !canManageVercel}
                        tooltip={
                          canManageVercel
                            ? undefined
                            : "You don't have permission to manage the Vercel integration"
                        }
                      >
                        Remove integration…
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Remove Vercel integration</DialogTitle>
                      </DialogHeader>
                      <DialogDescription>
                        This will permanently remove the Vercel integration and disconnect all
                        projects. This action cannot be undone.
                      </DialogDescription>
                      <FormButtons
                        confirmButton={
                          <Form method="post">
                            <input type="hidden" name="intent" value="uninstall" />
                            <Button variant="danger/medium" type="submit" disabled={isUninstalling}>
                              {isUninstalling ? "Removing…" : "Remove integration"}
                            </Button>
                          </Form>
                        }
                        cancelButton={
                          <DialogClose asChild>
                            <Button variant="secondary/medium">Cancel</Button>
                          </DialogClose>
                        }
                      />
                    </DialogContent>
                  </Dialog>
                  {actionData?.error ? (
                    <Paragraph variant="small" className="text-error">
                      {actionData.error}
                    </Paragraph>
                  ) : null}
                </div>
              }
            />
          </SettingsSection>

          <SettingsSection>
            <SettingsHeader
              // Keep the header's divide when there's no table; the table's own top
              // border is the divide once rows are present.
              className={connectedProjects.length === 0 ? undefined : "border-b-0"}
              title={`${connectedProjects.length} connected ${
                connectedProjects.length === 1 ? "project" : "projects"
              }`}
            />
            {connectedProjects.length === 0 ? (
              <Paragraph variant="small" className="pt-4 text-text-dimmed">
                No projects are connected to this Vercel integration yet.
              </Paragraph>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Project name</TableHeaderCell>
                    <TableHeaderCell>Vercel project ID</TableHeaderCell>
                    <TableHeaderCell>Connected</TableHeaderCell>
                    <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connectedProjects.map((projectIntegration) => (
                    <TableRow key={projectIntegration.id}>
                      <TableCell>{projectIntegration.project.name}</TableCell>
                      <TableCell className="font-mono text-xs font-medium text-text-dimmed transition-[color] group-hover/table-row:text-text-bright">
                        {projectIntegration.externalEntityId}
                      </TableCell>
                      <TableCell>
                        <DateTime date={projectIntegration.createdAt} />
                      </TableCell>
                      <TableCell isSticky>
                        <SimpleTooltip
                          asChild
                          disableHoverableContent
                          content="Configure"
                          button={
                            <span className="flex">
                              <LinkButton
                                variant="secondary/small-icon"
                                LeadingIcon={Cog6ToothIcon}
                                className="w-6 min-w-0 px-0"
                                to={v3ProjectSettingsIntegrationsPath(
                                  organization,
                                  projectIntegration.project,
                                  { slug: "prod" } // Default to production environment
                                )}
                              />
                            </span>
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SettingsSection>
        </SettingsContainer>
      </PageBody>
    </PageContainer>
  );
}
