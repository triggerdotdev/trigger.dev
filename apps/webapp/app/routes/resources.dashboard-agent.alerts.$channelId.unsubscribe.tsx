import { EnvelopeIcon } from "@heroicons/react/24/solid";
import { Form, useNavigation } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { verifyUnsubscribeToken } from "~/services/dashboardAgentAlertUnsubscribeToken.server";
import {
  DASHBOARD_AGENT_WATCH_ALERT_TYPE,
  unsubscribeChannelFromWatchAlerts,
} from "~/services/dashboardAgentWatchAlerts.server";
import { logger } from "~/services/logger.server";
import { rootPath } from "~/utils/pathBuilder";

/**
 * The unsubscribe link in a watch alert email. The signed token is the whole authorization
 * and names one channel; GET confirms and POST acts, so a link preview can't unsubscribe.
 */

const ParamsSchema = z.object({ channelId: z.string().min(1) });

async function authorize(request: Request, params: Record<string, unknown>) {
  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) return undefined;

  const token = new URL(request.url).searchParams.get("token");
  if (!token) return undefined;

  const claims = await verifyUnsubscribeToken(token);
  if (!claims) return undefined;
  if (claims.channelId !== parsedParams.data.channelId) return undefined;
  if (claims.alertType !== DASHBOARD_AGENT_WATCH_ALERT_TYPE) return undefined;

  return claims;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const claims = await authorize(request, params);
  // The POST needs the token, and a bare `<Form method="post">` drops search params.
  return typedjson({
    valid: claims !== undefined,
    formAction: `${new URL(request.url).pathname}${new URL(request.url).search}`,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return typedjson({ success: false as const, message: "Method not allowed" }, { status: 405 });
  }

  const claims = await authorize(request, params);
  if (!claims) {
    return typedjson(
      {
        success: false as const,
        message: "This link is no longer valid, so we couldn't turn off the alerts.",
      },
      { status: 403 }
    );
  }

  // Read only for the failure log. The unsubscribe does its own scoped lookup.
  const channel = await prisma.projectAlertChannel.findFirst({
    where: { id: claims.channelId },
    select: { projectId: true },
  });

  try {
    const result = await unsubscribeChannelFromWatchAlerts(claims.channelId);
    if (!result.ok) {
      return result.reason === "conflict"
        ? typedjson(
            {
              success: false as const,
              message: "This alert was being changed elsewhere. Please try again.",
            },
            { status: 409 }
          )
        : typedjson(
            { success: false as const, message: "This alert no longer exists." },
            { status: 404 }
          );
    }

    return typedjson({ success: true as const, channelName: result.channelName });
  } catch (error) {
    logger.error("Failed to turn off watch alerts from an email link", {
      error,
      channelId: claims.channelId,
      projectId: channel?.projectId,
    });
    throw error;
  }
}

export default function Page() {
  const { valid, formAction } = useTypedLoaderData<typeof loader>();
  const result = useTypedActionData<typeof action>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  if (result?.success) {
    return (
      <Shell title="Alerts turned off">
        <Paragraph spacing>
          {result.channelName} will no longer be alerted when a watch fires. You can turn it back on
          from the Alerts page in your project.
        </Paragraph>
        <LinkButton variant="primary/medium" to={rootPath()}>
          Dashboard
        </LinkButton>
      </Shell>
    );
  }

  if (!valid || result?.success === false) {
    return (
      <Shell title="Link no longer valid">
        <Paragraph spacing>
          {result?.success === false
            ? result.message
            : "This link is no longer valid. You can manage alerts from the Alerts page in your project."}
        </Paragraph>
        <LinkButton variant="primary/medium" to={rootPath()}>
          Dashboard
        </LinkButton>
      </Shell>
    );
  }

  return (
    <Shell title="Turn off watch alerts?">
      <Paragraph spacing>
        This stops the alerts this channel receives when a watch you set up with the dashboard agent
        fires. Other alerts on the channel are unaffected.
      </Paragraph>
      <Form method="post" action={formAction}>
        <Button variant="primary/medium" disabled={isLoading}>
          {isLoading ? "Turning off…" : "Turn off these alerts"}
        </Button>
      </Form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <AppContainer>
      <MainCenteredContainer className="max-w-88">
        <div>
          <FormTitle
            LeadingIcon={<EnvelopeIcon className="size-6 text-cyan-500" />}
            title={title}
          />
          {children}
        </div>
      </MainCenteredContainer>
    </AppContainer>
  );
}
