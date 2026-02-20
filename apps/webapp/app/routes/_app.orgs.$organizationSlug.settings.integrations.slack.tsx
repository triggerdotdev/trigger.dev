import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { fromPromise } from "neverthrow";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { SlackIcon } from "@trigger.dev/companyicons";
import { TrashIcon } from "@heroicons/react/20/solid";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { $transaction, prisma } from "~/db.server";
import { requireOrganization } from "~/services/org.server";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";
import { logger } from "~/services/logger.server";

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
  const { organization } = await requireOrganization(request, organizationSlug);

  const slackIntegration = await prisma.organizationIntegration.findFirst({
    where: {
      organizationId: organization.id,
      service: "SLACK",
      deletedAt: null,
    },
  });

  if (!slackIntegration) {
    return typedjson({
      organization,
      slackIntegration: null,
      alertChannels: [],
      teamName: null,
    });
  }

  const integrationData = slackIntegration.integrationData as any;
  const teamName = integrationData?.team?.name ?? null;

  const alertChannels = await prisma.projectAlertChannel.findMany({
    where: {
      type: "SLACK",
      project: { organizationId: organization.id },
      OR: [
        { integrationId: slackIntegration.id },
        {
          properties: {
            path: ["integrationId"],
            equals: slackIntegration.id,
          },
        },
      ],
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
    slackIntegration,
    alertChannels,
    teamName,
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

  const slackIntegration = await prisma.organizationIntegration.findFirst({
    where: {
      organizationId: organization.id,
      service: "SLACK",
      deletedAt: null,
    },
  });

  if (!slackIntegration) {
    return json({ error: "Slack integration not found" }, { status: 404 });
  }

  const txResult = await fromPromise(
    $transaction(prisma, async (tx) => {
      await tx.projectAlertChannel.updateMany({
        where: {
          type: "SLACK",
          OR: [
            { integrationId: slackIntegration.id },
            {
              properties: {
                path: ["integrationId"],
                equals: slackIntegration.id,
              },
            },
          ],
        },
        data: {
          enabled: false,
          integrationId: null,
        },
      });

      await tx.organizationIntegration.update({
        where: { id: slackIntegration.id },
        data: { deletedAt: new Date() },
      });
    }),
    (error) => error
  );

  if (txResult.isErr()) {
    logger.error("Failed to remove Slack integration", {
      organizationId: organization.id,
      organizationSlug,
      userId,
      integrationId: slackIntegration.id,
      error: txResult.error instanceof Error ? txResult.error.message : String(txResult.error),
    });

    return json(
      { error: "Failed to remove Slack integration. Please try again." },
      { status: 500 }
    );
  }

  logger.info("Slack integration removed successfully", {
    organizationId: organization.id,
    organizationSlug,
    userId,
    integrationId: slackIntegration.id,
  });

  return redirect(`/orgs/${organizationSlug}/settings`);
};

export default function SlackIntegrationPage() {
  const { slackIntegration, alertChannels, teamName } =
    useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isUninstalling =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "uninstall";

  if (!slackIntegration) {
    return (
      <PageContainer>
        <PageBody>
          <div className="flex flex-col items-center justify-center py-8">
            <Header1>No Slack Integration Found</Header1>
            <Paragraph className="mt-2 text-center text-text-dimmed">
              This organization doesn't have a Slack integration configured. You can connect Slack
              when setting up alert channels in your project settings.
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
          <Header1>Slack Integration</Header1>
          <Paragraph className="mt-2 text-text-dimmed">
            Manage your organization's Slack integration and connected alert channels.
          </Paragraph>
        </div>

        {/* Integration Info Section */}
        <div className="mb-8 rounded-lg border border-grid-bright bg-background-bright p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium text-text-bright">Integration Details</h2>
              <div className="mt-2 space-y-1 text-sm text-text-dimmed">
                {teamName && (
                  <div>
                    <span className="font-medium">Slack Workspace:</span> {teamName}
                  </div>
                )}
                <div>
                  <span className="font-medium">Installed:</span>{" "}
                  {formatDate(new Date(slackIntegration.createdAt))}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="danger/medium" LeadingIcon={TrashIcon} disabled={isUninstalling}>
                    Remove Integration
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Remove Slack Integration</DialogTitle>
                  </DialogHeader>
                  <DialogDescription>
                    This will remove the Slack integration and disable all connected alert channels.
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

        {/* Connected Alert Channels Section */}
        <div>
          <h2 className="mb-4 text-lg font-medium text-text-bright">
            Connected Alert Channels ({alertChannels.length})
          </h2>

          {alertChannels.length === 0 ? (
            <div className="rounded-lg border border-grid-bright bg-background-bright p-6 text-center">
              <Paragraph className="text-text-dimmed">
                No alert channels are currently connected to this Slack integration.
              </Paragraph>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Channel Name</TableHeaderCell>
                  <TableHeaderCell>Project</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Created</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alertChannels.map((channel) => (
                  <TableRow key={channel.id}>
                    <TableCell>{channel.name}</TableCell>
                    <TableCell>{channel.project.name}</TableCell>
                    <TableCell>
                      <EnabledStatus enabled={channel.enabled} />
                    </TableCell>
                    <TableCell>{formatDate(new Date(channel.createdAt))}</TableCell>
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
