import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { Form, useNavigation } from "@remix-run/react";
import type { SecurityNotice, SecurityNoticeEnvironment } from "@trigger.dev/plugins";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  canSeeSecurityNotices,
  getSecurityNoticesController,
} from "~/services/securityNotices.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  v3ApiKeysPath,
  v3EnvironmentVariablesPath,
  v3SecurityNoticesPath,
} from "~/utils/pathBuilder";

/** The project scope, or a 404 unless the plugin is loaded and the user is an Owner or Admin. */
async function requireNoticeScope(params: z.infer<typeof EnvironmentParamSchema>, userId: string) {
  const controller = await getSecurityNoticesController();
  const project = controller
    ? await prisma.project.findFirst({
        where: {
          slug: params.projectParam,
          deletedAt: null,
          organization: { slug: params.organizationSlug, members: { some: { userId } } },
        },
        select: { id: true, organizationId: true },
      })
    : null;
  const scope = project
    ? { organizationId: project.organizationId, projectId: project.id, userId }
    : null;
  if (!controller || !scope || !(await canSeeSecurityNotices(scope))) {
    throw new Response("Not Found", { status: 404 });
  }
  return { controller, scope };
}

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
  },
  async ({ params, user }) => {
    const { controller, scope } = await requireNoticeScope(params, user.id);
    return typedjson({ notices: await controller.listForProject(scope) });
  }
);

const ActionSchema = z.object({
  intent: z.literal("mark-handled"),
  noticeEnvironmentId: z.string().min(1),
});

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
  },
  async ({ request, params, user }) => {
    const path = v3SecurityNoticesPath(
      { slug: params.organizationSlug },
      { slug: params.projectParam },
      { slug: params.envParam }
    );

    const parsed = ActionSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) {
      return redirectWithErrorMessage(path, request, "Invalid request");
    }

    const { controller, scope } = await requireNoticeScope(params, user.id);
    const { noticeEnvironmentId } = parsed.data;
    const result = await controller.acknowledge({ ...scope, noticeEnvironmentId });
    if (!result.ok) {
      return redirectWithErrorMessage(path, request, "That notice no longer exists");
    }

    logger.info("Security notice marked as handled", { ...scope, noticeEnvironmentId });
    return redirectWithSuccessMessage(path, request, "Marked as handled");
  }
);

export default function Page() {
  const { notices } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Security notices" />
      </NavBar>
      <PageBody>
        <MainHorizontallyCenteredContainer className="flex max-w-3xl flex-col gap-10 py-6">
          {notices.length === 0 ? (
            <Paragraph>There are no security notices for this project.</Paragraph>
          ) : (
            notices.map((notice) => <Notice key={notice.id} notice={notice} />)
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

function Notice({ notice }: { notice: SecurityNotice }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Header2>{notice.title}</Header2>
        {notice.summary
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((paragraph, i) => (
            <Paragraph key={i} variant="small" className="whitespace-pre-line">
              {paragraph}
            </Paragraph>
          ))}
        {notice.detailsUrl && (
          <Paragraph variant="small">
            <TextLink href={notice.detailsUrl} target="_blank" rel="noreferrer">
              Read the full details
            </TextLink>
          </Paragraph>
        )}
      </div>
      {notice.environments.map((env) => (
        <AffectedEnvironment key={env.id} env={env} />
      ))}
    </section>
  );
}

function StepStatus({ done, label }: { done: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        done ? "text-success" : "text-warning"
      )}
    >
      {done ? (
        <CheckCircleIcon className="size-4" />
      ) : (
        <ExclamationTriangleIcon className="size-4" />
      )}
      {label}
    </span>
  );
}

function ApiKeyStatus({ env }: { env: SecurityNoticeEnvironment }) {
  switch (env.apiKeyStatus) {
    case "exposed":
      return <StepStatus done={false} label="Still the exposed key" />;
    case "grace":
      return <StepStatus done={false} label="Regenerated, exposed key still works" />;
    case "revoked":
      return <StepStatus done label="Exposed key revoked" />;
  }
}

function AffectedEnvironment({ env }: { env: SecurityNoticeEnvironment }) {
  const organization = useOrganization();
  const project = useProject();
  const navigation = useNavigation();
  const environmentForPath = { slug: env.environmentSlug };
  const environment = { type: env.environmentType, branchName: env.branchName } as Parameters<
    typeof EnvironmentCombo
  >[0]["environment"];
  const isMarking = navigation.formData?.get("noticeEnvironmentId") === env.id;

  return (
    <div className="flex flex-col gap-4 rounded-md border border-grid-bright bg-background-bright p-4">
      <div className="flex items-center justify-between gap-2">
        <Header3>
          <EnvironmentCombo
            environment={environment}
            className="text-base"
            iconClassName="size-5"
          />
        </Header3>
        {env.acknowledgedAt ? (
          <Badge variant="extra-small">Handled</Badge>
        ) : (
          <Badge variant="extra-small" className="system-mono-label text-error">
            Action needed
          </Badge>
        )}
      </div>

      <Paragraph variant="small">
        Exposed on <DateTime date={env.exposedAt} includeTime />. Treat this environment's secret
        API key and every environment variable in it as exposed.
      </Paragraph>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Paragraph variant="small/bright">1. Regenerate the secret API key</Paragraph>
          <ApiKeyStatus env={env} />
        </div>
        <Paragraph variant="small">
          Do this first and choose &quot;Revoke the previous key immediately&quot;, then update{" "}
          <InlineCode>TRIGGER_SECRET_KEY</InlineCode> wherever you trigger tasks from.
        </Paragraph>
        {env.apiKeyStatus === "grace" && env.apiKeyGraceEndsAt && (
          <Paragraph variant="small" className="text-warning">
            The exposed key still works until <DateTime date={env.apiKeyGraceEndsAt} includeTime />.
            Regenerate again with &quot;Revoke the previous key immediately&quot; to stop it now.
          </Paragraph>
        )}
        <div>
          <LinkButton
            variant="secondary/small"
            to={v3ApiKeysPath(organization, project, environmentForPath)}
          >
            Go to API keys
          </LinkButton>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Paragraph variant="small/bright">
          2. Rotate every secret in this environment&apos;s variables
        </Paragraph>
        <Paragraph variant="small">
          Revoke each value at the service that issued it, create a new one, then update it on the
          environment variables page. Changing a value in Trigger.dev doesn't revoke the old one.
        </Paragraph>
        <div>
          <LinkButton
            variant="secondary/small"
            to={v3EnvironmentVariablesPath(organization, project, environmentForPath)}
          >
            Go to environment variables
          </LinkButton>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-grid-bright pt-3">
        {env.acknowledgedAt ? (
          <Paragraph variant="small">
            Marked as handled
            {env.acknowledgedBy
              ? ` by ${env.acknowledgedBy.name ?? env.acknowledgedBy.email}`
              : ""}{" "}
            on <DateTime date={env.acknowledgedAt} includeTime />.
          </Paragraph>
        ) : (
          <>
            <Paragraph variant="small">
              3. When you've finished, mark this environment as handled to clear the banner.
            </Paragraph>
            <Form method="post">
              <input type="hidden" name="intent" value="mark-handled" />
              <input type="hidden" name="noticeEnvironmentId" value={env.id} />
              <Button
                type="submit"
                variant="primary/small"
                isLoading={isMarking}
                disabled={navigation.state === "submitting"}
              >
                {isMarking ? "Marking…" : "Mark as handled"}
              </Button>
            </Form>
          </>
        )}
      </div>
    </div>
  );
}
