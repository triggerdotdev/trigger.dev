import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { fromPromise } from "neverthrow";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header1 } from "~/components/primitives/Headers";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "~/components/primitives/Table";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { $transaction, prisma } from "~/db.server";
import { requireOrganization } from "~/services/org.server";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";
import { logger } from "~/services/logger.server";
import { TrashIcon } from "@heroicons/react/20/solid";
import { v3ProjectSettingsPath } from "~/utils/pathBuilder";
import { LinkButton } from "~/components/primitives/Buttons";

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const url = new URL(request.url);
  const configurationId = url.searchParams.get("configurationId") ?? undefined;
  const { organization } = await requireOrganization(request, organizationSlug);
  
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
  });
};

const ActionSchema = z.object({
  intent: z.literal("uninstall"),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
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
  const uninstallResult = await VercelIntegrationRepository.uninstallVercelIntegration(vercelIntegration);

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
};

export default function VercelIntegrationPage() {
  const { organization, vercelIntegration, connectedProjects, teamId, installationId } = 
    useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isUninstalling = navigation.state === "submitting" && 
    navigation.formData?.get("intent") === "uninstall";

  if (!vercelIntegration) {
    return (
      <PageContainer>
        <PageBody>
          <div className="flex flex-col items-center justify-center py-8">
            <Header1>No Vercel Integration Found</Header1>
            <Paragraph className="mt-2 text-center text-text-dimmed">
              This organization doesn't have a Vercel integration configured.
            </Paragraph>
          </div>
        </PageBody>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageBody>
        <div className="mb-8">
          <Header1>Vercel Integration</Header1>
          <Paragraph className="mt-2 text-text-dimmed">
            Manage your organization's Vercel integration and connected projects.
          </Paragraph>
        </div>

        {/* Integration Info Section */}
        <div className="mb-8 rounded-lg border border-grid-bright bg-background-bright p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium text-text-bright">Integration Details</h2>
              <div className="mt-2 space-y-1 text-sm text-text-dimmed">
                {teamId && (
                  <div>
                    <span className="font-medium">Vercel Team ID:</span> {teamId}
                  </div>
                )}
                {installationId && (
                  <div>
                    <span className="font-medium">Installation ID:</span> {installationId}
                  </div>
                )}
                <div>
                  <span className="font-medium">Installed:</span>{" "}
                  {formatDate(new Date(vercelIntegration.createdAt))}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="danger/medium"
                    LeadingIcon={TrashIcon}
                    disabled={isUninstalling}
                  >
                    Remove Integration
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Remove Vercel Integration</DialogTitle>
                  </DialogHeader>
                  <DialogDescription>
                    This will permanently remove the Vercel integration and disconnect all projects. 
                    This action cannot be undone.
                  </DialogDescription>
                  <FormButtons
                    confirmButton={
                      <Form method="post">
                        <input type="hidden" name="intent" value="uninstall" />
                        <Button
                          variant="danger/medium"
                          LeadingIcon={TrashIcon}
                          type="submit"
                          disabled={isUninstalling}
                        >
                          {isUninstalling ? "Removing..." : "Remove Integration"}
                        </Button>
                      </Form>
                    }
                    cancelButton={
                      <DialogClose asChild>
                        <Button variant="tertiary/medium">Cancel</Button>
                      </DialogClose>
                    }
                  />
                </DialogContent>
              </Dialog>
              {actionData?.error && (
                <Paragraph variant="small" className="text-error">
                  {actionData.error}
                </Paragraph>
              )}
            </div>
          </div>
        </div>

        {/* Connected Projects Section */}
        <div>
          <h2 className="mb-4 text-lg font-medium text-text-bright">
            Connected Projects ({connectedProjects.length})
          </h2>
          
          {connectedProjects.length === 0 ? (
            <div className="rounded-lg border border-grid-bright bg-background-bright p-6 text-center">
              <Paragraph className="text-text-dimmed">
                No projects are currently connected to this Vercel integration.
              </Paragraph>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Project Name</TableHeaderCell>
                  <TableHeaderCell>Vercel Project ID</TableHeaderCell>
                  <TableHeaderCell>Connected</TableHeaderCell>
                  <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connectedProjects.map((projectIntegration) => (
                  <TableRow key={projectIntegration.id}>
                    <TableCell>{projectIntegration.project.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {projectIntegration.externalEntityId}
                    </TableCell>
                    <TableCell>
                      {formatDate(new Date(projectIntegration.createdAt))}
                    </TableCell>
                    <TableCell>
                      <LinkButton
                        variant="minimal/small"
                        to={v3ProjectSettingsPath(
                          organization,
                          projectIntegration.project,
                          { slug: "prod" } // Default to production environment
                        )}
                      >
                        Configure
                      </LinkButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}