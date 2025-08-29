import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
import { Header1 } from "~/components/primitives/Headers";
import { Icon } from "~/components/primitives/Icon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { logger } from "~/services/logger.server";
import { createPersonalAccessTokenFromAuthorizationCode } from "~/services/personalAccessToken.server";
import { requireUserId } from "~/services/session.server";

const ParamsSchema = z.object({
  authorizationCode: z.string(),
});

const SearchParamsSchema = z.object({
  source: z.string().optional(),
  clientName: z.string().optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    logger.info("Invalid params", { params });
    throw new Response(undefined, {
      status: 400,
      statusText: "Invalid params",
    });
  }

  const url = new URL(request.url);
  const searchObject = Object.fromEntries(url.searchParams.entries());

  const searchParams = SearchParamsSchema.safeParse(searchObject);

  const source = (searchParams.success ? searchParams.data.source : undefined) ?? "cli";
  const clientName = (searchParams.success ? searchParams.data.clientName : undefined) ?? "unknown";

  try {
    const personalAccessToken = await createPersonalAccessTokenFromAuthorizationCode(
      parsedParams.data.authorizationCode,
      userId
    );
    return typedjson({
      success: true as const,
      source,
      clientName,
    });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    if (error instanceof Error) {
      return typedjson({
        success: false as const,
        error: error.message,
        source,
        clientName,
      });
    }

    logger.error(JSON.stringify(error));
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const result = useTypedLoaderData<typeof loader>();

  return (
    <AppContainer>
      <MainCenteredContainer className="max-w-[22rem]">
        <div className="flex flex-col items-center space-y-4">
          {result.success ? (
            <div>
              <Header1 className="mb-2 flex items-center gap-1">
                <Icon icon={CheckCircleIcon} className="h-6 w-6 text-emerald-500" /> Successfully
                authenticated
              </Header1>
              <Paragraph>{getInstructionsForSource(result.source, result.clientName)}</Paragraph>
            </div>
          ) : (
            <div>
              <Header1 className="mb-2">Authentication failed</Header1>
              <Callout variant="error" className="my-2">
                {result.error}
              </Callout>
              <Paragraph spacing>
                There was a problem authenticating you, please try logging in with your CLI again.
              </Paragraph>
            </div>
          )}
        </div>
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

function getInstructionsForSource(source: string, clientName: string) {
  if (source === "mcp") {
    if (clientName) {
      return `Return to your ${prettyClientNames[clientName] ?? clientName} to continue.`;
    }
  }

  return `Return to your terminal to continue.`;
}
