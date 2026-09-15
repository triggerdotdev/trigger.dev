import { type ActionFunctionArgs, type LoaderFunctionArgs, json, redirect } from "@remix-run/node";
import { fromPromise } from "neverthrow";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { SlackMonoIcon } from "~/assets/icons/SlackMonoIcon";
import { ProjectConnectSelect } from "~/components/integrations/ProjectConnectSelect";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header2 } from "~/components/primitives/Headers";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
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
import {
  OrganizationParamsSchema,
  organizationSlackIntegrationPath,
  v3ErrorsPath,
} from "~/utils/pathBuilder";
import { useOrganization } from "~/hooks/useOrganizations";
import { logger } from "~/services/logger.server";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Slack integration");

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

  return redirect(organizationSlackIntegrationPath({ slug: organizationSlug }));
};

export default function SlackIntegrationPage() {
  const { slackIntegration, alertChannels, teamName } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isUninstalling =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "uninstall";

  const organization = useOrganization();
  const projects = organization.projects;

  if (!slackIntegration) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Slack integration" />
        </NavBar>
        <PageBody>
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <SlackMonoIcon className="mb-2 size-16 text-secondary" />
            <Header2>No Slack integration found</Header2>
            <Paragraph className="max-w-md text-center text-text-dimmed">
              Your organization doesn't have a Slack integration. Connect Slack when setting up
              alerts from the Errors page.
            </Paragraph>
            {projects.length > 0 ? (
              <ProjectConnectSelect
                projects={projects}
                configurePathFor={(project) =>
                  `${v3ErrorsPath(organization, project, { slug: "prod" })}?alerts=true`
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
        <PageTitle title="Slack integration" />
      </NavBar>
      <PageBody>
        <SettingsContainer>
          <SettingsSection>
            <SettingsHeader title="Overview" />
            {teamName ? (
              <SettingsRow
                title="Workspace"
                action={<span className="text-sm text-text-bright">{teamName}</span>}
              />
            ) : null}
            <SettingsRow
              title="Installed"
              action={
                <span className="text-sm text-text-bright">
                  <DateTime date={slackIntegration.createdAt} />
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
                      <Button variant="danger/small" disabled={isUninstalling}>
                        Remove integration…
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Remove Slack integration</DialogTitle>
                      </DialogHeader>
                      <DialogDescription>
                        This will remove the Slack integration and disable all connected alert
                        channels. This action cannot be undone.
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
              className={alertChannels.length === 0 ? undefined : "border-b-0"}
              title={`${alertChannels.length} connected alert ${
                alertChannels.length === 1 ? "channel" : "channels"
              }`}
            />
            {alertChannels.length === 0 ? (
              <Paragraph variant="small" className="pt-4 text-text-dimmed">
                No alert channels are connected to this Slack integration yet.
              </Paragraph>
            ) : (
              <Table variant="bright/no-hover">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Channel</TableHeaderCell>
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
                      <TableCell>
                        <DateTime date={channel.createdAt} />
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
