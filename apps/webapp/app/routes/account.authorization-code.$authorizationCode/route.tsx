import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Form } from "@remix-run/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header1 } from "~/components/primitives/Headers";
import { Icon } from "~/components/primitives/Icon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  compareCliLoginNetworks,
  describeIpLocation,
  needsNetworkConfirmation,
} from "~/services/cliLoginNetwork.server";
import { logger } from "~/services/logger.server";
import {
  createPersonalAccessTokenFromAuthorizationCode,
  getMintableAuthorizationCode,
} from "~/services/personalAccessToken.server";
import { getIpLocation } from "~/services/platform.v3.server";
import { scheduleEmail } from "~/services/scheduleEmail.server";
import { requireUser } from "~/services/session.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Authorize login");

const ParamsSchema = z.object({
  authorizationCode: z.string(),
});

const SearchParamsSchema = z.object({
  source: z.string().optional(),
  clientName: z.string().optional(),
});

const ORGANIZATION_DISPLAY_LIMIT = 10;

function parseParams(params: unknown) {
  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    logger.info("Invalid params", { params });
    throw new Response(undefined, { status: 400, statusText: "Invalid params" });
  }
  return parsedParams.data;
}

function parseSearch(request: Request) {
  const url = new URL(request.url);
  const searchObject = Object.fromEntries(url.searchParams.entries());
  const searchParams = SearchParamsSchema.safeParse(searchObject);
  const source = (searchParams.success ? searchParams.data.source : undefined) ?? "cli";
  const clientName = (searchParams.success ? searchParams.data.clientName : undefined) ?? "unknown";
  return { source, clientName };
}

// The loader only renders a consent screen; minting/binding a PAT happens in
// the `action`, behind an explicit "Authorize" POST.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const { authorizationCode } = parseParams(params);
  const { source, clientName } = parseSearch(request);

  const mintable = await getMintableAuthorizationCode(authorizationCode);

  if (!mintable) {
    return typedjson({ status: "invalid" as const, source, clientName });
  }

  // The token acts as the user, so it can reach every organization they belong to.
  const organizationWhere = { deletedAt: null, members: { some: { userId: user.id } } };
  const [organizations, organizationCount, requesterLocation] = await Promise.all([
    prisma.organization.findMany({
      select: { id: true, title: true },
      where: organizationWhere,
      orderBy: { title: "asc" },
      take: ORGANIZATION_DISPLAY_LIMIT,
    }),
    prisma.organization.count({ where: organizationWhere }),
    getIpLocation(mintable.requesterIp),
  ]);

  const networkMatch = compareCliLoginNetworks(
    mintable.requesterIp,
    extractClientIp(request.headers.get("x-forwarded-for"))
  );

  return typedjson({
    status: "consent" as const,
    source,
    clientName,
    legacy: mintable.legacy,
    requesterIp: mintable.requesterIp,
    requesterLocation: describeIpLocation(requesterLocation) ?? null,
    startedMinutesAgo: Math.max(
      0,
      Math.floor((Date.now() - mintable.createdAt.getTime()) / 60_000)
    ),
    requiresNetworkConfirmation:
      env.CLI_LOGIN_NETWORK_CHECK === "confirm" && needsNetworkConfirmation(networkMatch),
    account: {
      email: user.email,
      name: user.displayName ?? user.name,
    },
    organizations,
    hiddenOrganizationCount: organizationCount - organizations.length,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;

  const { authorizationCode } = parseParams(params);
  const { source, clientName } = parseSearch(request);
  const formData = await request.formData();

  try {
    const token = await createPersonalAccessTokenFromAuthorizationCode(authorizationCode, userId, {
      approverIp: extractClientIp(request.headers.get("x-forwarded-for")),
      confirmedDifferentNetwork: formData.get("confirmDifferentNetwork") === "on",
    });

    await notifyLoginAuthorized({
      userEmail: user.email,
      clientDescription: describeClient(source, clientName),
      obfuscatedToken: token.obfuscatedToken,
      requesterIp: token.requesterIp,
    });

    if (token.approval?.callbackPort) {
      const callbackUrl = new URL(`http://127.0.0.1:${token.approval.callbackPort}/callback`);
      callbackUrl.searchParams.set("approval_code", token.approval.approvalCode);
      throw redirect(callbackUrl.href);
    }

    return typedjson({
      success: true as const,
      source,
      clientName,
      approvalCode: token.approval?.approvalCode,
    });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    if (error instanceof Error) {
      return typedjson({ success: false as const, error: error.message, source, clientName });
    }

    logger.error(JSON.stringify(error), { userId });
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const loaderData = useTypedLoaderData<typeof loader>();
  const actionData = useTypedActionData<typeof action>();

  // After the consent POST: success or failure.
  if (actionData) {
    return (
      <AuthShell>
        {actionData.success && actionData.approvalCode ? (
          <div className="flex flex-col gap-4">
            <Header1>Finish logging in</Header1>
            <Paragraph>Paste this code into the terminal where you started the login.</Paragraph>
            <ClipboardField value={actionData.approvalCode} variant="secondary/medium" />
            <Callout variant="warning">
              Never share this code. Anyone who has it can finish this login and act as you.
            </Callout>
          </div>
        ) : actionData.success ? (
          <div>
            <Header1 className="mb-2 flex items-center gap-1">
              <Icon icon={CheckCircleIcon} className="h-6 w-6 text-emerald-500" /> Successfully
              authenticated
            </Header1>
            <Paragraph>
              {getInstructionsForSource(actionData.source, actionData.clientName)}
            </Paragraph>
          </div>
        ) : (
          <div>
            <Header1 className="mb-2">Authentication failed</Header1>
            <Callout variant="error" className="my-2">
              {actionData.error}
            </Callout>
            <Paragraph spacing>
              There was a problem authenticating you, please try logging in with your CLI again.
            </Paragraph>
          </div>
        )}
      </AuthShell>
    );
  }

  // Initial GET: invalid/expired code, or the consent prompt.
  if (loaderData.status === "invalid") {
    return (
      <AuthShell>
        <div>
          <Header1 className="mb-2">Authentication failed</Header1>
          <Callout variant="error" className="my-2">
            This login link is invalid or has expired.
          </Callout>
          <Paragraph spacing>
            Please try logging in with your CLI again to get a fresh link.
          </Paragraph>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="flex flex-col gap-4">
        <Header1>Authorize login</Header1>
        <Paragraph>{getConsentPrompt(loaderData.source, loaderData.clientName)}</Paragraph>
        <Paragraph variant="small">
          {describeLoginStart(
            loaderData.startedMinutesAgo,
            loaderData.requesterIp,
            loaderData.requesterLocation
          )}
        </Paragraph>
        {loaderData.legacy && (
          <Callout variant="warning">
            This login was started by an outdated version of the Trigger.dev CLI, which can't
            confirm it is running on your computer. Only continue if you just ran a login command
            yourself, and upgrade the CLI afterwards.
          </Callout>
        )}
        <ConsentForm requiresNetworkConfirmation={loaderData.requiresNetworkConfirmation} />
        <Paragraph variant="extra-small">
          Only authorize if you started this login yourself. If you didn't, close this page.
        </Paragraph>
        {loaderData.requesterLocation && (
          <Paragraph variant="extra-small">
            <TextLink href="https://ipinfo.io" target="_blank">
              IP address data powered by IPinfo
            </TextLink>
          </Paragraph>
        )}
        <div className="flex flex-col gap-3 rounded-md border border-grid-bright p-3">
          <div>
            <Paragraph variant="base/bright" className="font-medium">
              {loaderData.account.email}
            </Paragraph>
            {loaderData.account.name && (
              <Paragraph variant="small">{loaderData.account.name}</Paragraph>
            )}
          </div>
          {loaderData.organizations.length === 0 ? (
            <Paragraph variant="small">You're not a member of any organizations yet.</Paragraph>
          ) : (
            <div>
              <Paragraph variant="small">
                This will grant access to the following organizations:
              </Paragraph>
              <ul className="mt-1 list-inside list-disc text-sm text-text-bright">
                {loaderData.organizations.map((organization) => (
                  <li key={organization.id}>{organization.title}</li>
                ))}
                {loaderData.hiddenOrganizationCount > 0 && (
                  <li>and {loaderData.hiddenOrganizationCount} more</li>
                )}
              </ul>
            </div>
          )}
        </div>
      </div>
    </AuthShell>
  );
}

function ConsentForm({ requiresNetworkConfirmation }: { requiresNetworkConfirmation: boolean }) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Form method="post" className="flex flex-col gap-3">
      {requiresNetworkConfirmation && (
        <>
          <Callout variant="warning">
            This login was started from a different network than the one you're on now. If someone
            sent you this link, close this page.
          </Callout>
          <CheckboxWithLabel
            name="confirmDifferentNetwork"
            value="on"
            variant="simple/small"
            label="I started this login myself, on another machine"
            onChange={setConfirmed}
          />
        </>
      )}
      <Button
        type="submit"
        variant="primary/medium"
        fullWidth
        disabled={requiresNetworkConfirmation && !confirmed}
      >
        Authorize
      </Button>
    </Form>
  );
}

function describeLoginStart(
  startedMinutesAgo: number,
  requesterIp: string | null,
  requesterLocation: string | null
) {
  const when =
    startedMinutesAgo === 0
      ? "just now"
      : `${startedMinutesAgo} minute${startedMinutesAgo === 1 ? "" : "s"} ago`;
  if (!requesterIp) {
    return `This login was started ${when}.`;
  }
  return requesterLocation
    ? `This login was started ${when} from IP address ${requesterIp} (${requesterLocation}).`
    : `This login was started ${when} from IP address ${requesterIp}.`;
}

function describeClient(source: string, clientName: string) {
  if (source === "mcp") {
    return knownClientName(clientName) ?? "an MCP client";
  }
  return "the Trigger.dev CLI";
}

async function notifyLoginAuthorized(details: {
  userEmail: string;
  clientDescription: string;
  obfuscatedToken: string;
  requesterIp: string | null;
}) {
  try {
    const requesterLocation = describeIpLocation(await getIpLocation(details.requesterIp));
    await scheduleEmail({
      email: "cli-login-authorized",
      to: details.userEmail,
      userEmail: details.userEmail,
      clientDescription: details.clientDescription,
      obfuscatedToken: details.obfuscatedToken,
      requesterIp: details.requesterIp ?? undefined,
      requesterLocation,
      authorizedAt: new Date().toUTCString(),
      tokensUrl: `${env.APP_ORIGIN}/account/tokens`,
    });
  } catch (error) {
    logger.error("Failed to schedule the CLI login authorized email", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <AppContainer>
      <MainCenteredContainer className="max-w-88">
        <div className="flex flex-col items-center space-y-4">{children}</div>
      </MainCenteredContainer>
    </AppContainer>
  );
}

const prettyClientNames: Record<string, string> = {
  "claude-code": "Claude Code",
  "cursor-vscode": "Cursor",
  "Visual Studio Code": "VSCode",
  "windsurf-client": "Windsurf",
  "claude-ai": "Claude Desktop",
};

function knownClientName(clientName: string): string | undefined {
  return Object.hasOwn(prettyClientNames, clientName) ? prettyClientNames[clientName] : undefined;
}

function getConsentPrompt(source: string, clientName: string) {
  if (source === "mcp") {
    const pretty = knownClientName(clientName);
    if (pretty) {
      return `Authorize ${pretty} to access your Trigger.dev account?`;
    }
    return `Authorize this MCP client to access your Trigger.dev account?`;
  }

  return `Authorize the Trigger.dev CLI to access your account?`;
}

function getInstructionsForSource(source: string, clientName: string) {
  if (source === "mcp") {
    const pretty = knownClientName(clientName);
    return pretty ? `Return to ${pretty} to continue.` : `Return to your MCP client to continue.`;
  }

  return `Return to your terminal to continue.`;
}
