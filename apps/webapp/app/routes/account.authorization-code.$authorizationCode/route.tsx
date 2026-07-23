import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Form } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header1 } from "~/components/primitives/Headers";
import { Icon } from "~/components/primitives/Icon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { logger } from "~/services/logger.server";
import {
  createPersonalAccessTokenFromAuthorizationCode,
  isAuthorizationCodeMintable,
} from "~/services/personalAccessToken.server";
import { requireUserId } from "~/services/session.server";

const ParamsSchema = z.object({
  authorizationCode: z.string(),
});

const SearchParamsSchema = z.object({
  source: z.string().optional(),
  clientName: z.string().optional(),
});

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
  await requireUserId(request);

  const { authorizationCode } = parseParams(params);
  const { source, clientName } = parseSearch(request);

  const mintable = await isAuthorizationCodeMintable(authorizationCode);

  return typedjson({
    status: mintable ? ("consent" as const) : ("invalid" as const),
    source,
    clientName,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);

  const { authorizationCode } = parseParams(params);
  const { source, clientName } = parseSearch(request);

  try {
    await createPersonalAccessTokenFromAuthorizationCode(authorizationCode, userId);
    return typedjson({ success: true as const, source, clientName });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    if (error instanceof Error) {
      return typedjson({ success: false as const, error: error.message, source, clientName });
    }

    logger.error(JSON.stringify(error));
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
        {actionData.success ? (
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
        <Form method="post">
          <Button type="submit" variant="primary/medium" fullWidth>
            Authorize
          </Button>
        </Form>
        <Paragraph variant="extra-small">
          Only authorize if you started this login yourself. If you didn't, close this page.
        </Paragraph>
      </div>
    </AuthShell>
  );
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

function getConsentPrompt(source: string, clientName: string) {
  if (source === "mcp") {
    const pretty = prettyClientNames[clientName] ?? clientName;
    if (pretty && pretty !== "unknown") {
      return `Authorize ${pretty} to access your Trigger.dev account?`;
    }
    return `Authorize this MCP client to access your Trigger.dev account?`;
  }

  return `Authorize the Trigger.dev CLI to access your account?`;
}

function getInstructionsForSource(source: string, clientName: string) {
  if (source === "mcp") {
    if (clientName) {
      return `Return to your ${prettyClientNames[clientName] ?? clientName} to continue.`;
    }
  }

  return `Return to your terminal to continue.`;
}
