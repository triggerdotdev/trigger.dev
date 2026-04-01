import { type ActionFunctionArgs, type LoaderFunctionArgs, json, redirect } from "@remix-run/node";
import { fromPromise } from "neverthrow";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { TrashIcon } from "@heroicons/react/20/solid";
import { IconBugFilled } from "@tabler/icons-react";
import { SlackMonoIcon } from "~/assets/icons/SlackMonoIcon";
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
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
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
import { OrganizationParamsSchema, organizationSlackIntegrationPath } from "~/utils/pathBuilder";
import { logger } from "~/services/logger.server";

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

  if (!slackIntegration) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Slack integration" />
        </NavBar>
        <PageBody>
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <SlackMonoIcon className="mb-2 size-16 text-charcoal-650" />
            <Header2>No Slack integration found</Header2>
            <Paragraph className="max-w-md text-center text-text-dimmed">
              Your organization doesn't have a Slack integration configured. You can connect Slack
              when setting up alerts from the{" "}
              <IconBugFilled className="-ml-0.5 mb-0.5 inline size-5 text-errors" />
              <span className="text-text-bright">Errors</span> page.
            </Paragraph>
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
        <MainHorizontallyCenteredContainer>
          <div className="flex flex-col gap-6">
            <div>
              <div className="mb-3 border-b border-grid-dimmed pb-3">
                <Header2>Integration details</Header2>
              </div>
              <div className="flex flex-col gap-1">
                {teamName && (
                  <Paragraph variant="small">
                    <span className="text-text-dimmed">Workspace:</span>{" "}
                    <span className="text-text-bright">{teamName}</span>
                  </Paragraph>
                )}
                <Paragraph variant="small">
                  <span className="text-text-dimmed">Installed:</span>{" "}
                  <span className="text-text-bright">
                    <DateTime date={slackIntegration.createdAt} />
                  </span>
                </Paragraph>
              </div>
            </div>

            <div>
              <Header3 spacing>
                Connected alert channels
                <span className="ml-1 text-text-dimmed">({alertChannels.length})</span>
              </Header3>
              {alertChannels.length === 0 ? (
                <Paragraph variant="small" className="text-text-dimmed">
                  No alert channels are currently connected to this Slack integration.
                </Paragraph>
              ) : (
                <Table>
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
            </div>

            <div>
              <Header2 spacing>Danger zone</Header2>
              <div className="w-full rounded-sm border border-rose-500/40 p-4">
                <Header3 spacing>Remove integration</Header3>
                <Hint>
                  This will remove the Slack integration and disable all connected alert channels.
                  This action cannot be undone.
                </Hint>
                {actionData?.error && (
                  <Paragraph variant="small" className="mt-2 text-error">
                    {actionData.error}
                  </Paragraph>
                )}
                <FormButtons
                  className="mt-2"
                  confirmButton={
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          variant="danger/small"
                          LeadingIcon={TrashIcon}
                          disabled={isUninstalling}
                        >
                          Remove integration
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Remove Slack integration</DialogTitle>
                        </DialogHeader>
                        <DialogDescription className="mb-2">
                          This will remove the Slack integration and disable all connected alert
                          channels. This action cannot be undone.
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
                                {isUninstalling ? "Removing…" : "Remove integration"}
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
                  }
                />
              </div>
            </div>
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
