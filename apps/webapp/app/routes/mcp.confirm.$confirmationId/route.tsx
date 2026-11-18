import {
  json,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  isRouteErrorResponse,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "@remix-run/react";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CodeBlock } from "~/components/code/CodeBlock";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { describeMcpSubject } from "~/mcp/confirm/confirmation.server";
import { getMcpConfirmationStore } from "~/mcp/confirm/storeInstance.server";
import { logger } from "~/services/logger.server";
import { assertNotImpersonating } from "~/services/oauth/authorize.server";
import { describeOAuthClientName } from "~/services/oauth/consent.server";
import { requireUser } from "~/services/session.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";

const CSRF_KEY = "mcp-confirm-csrf";
const TOO_LARGE = "These arguments are too large to review, so this call can't be approved.";
const noStore = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export const headers: HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => {
  const chosen = new Headers(
    errorHeaders ?? (actionHeaders.has("Cache-Control") ? actionHeaders : loaderHeaders)
  );
  for (const [name, value] of Object.entries(noStore)) chosen.set(name, value);
  return chosen;
};

function notFound(): never {
  throw new Response("Not Found", { status: 404, headers: noStore });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  assertNotImpersonating(user);
  const record = await getMcpConfirmationStore().get(params.confirmationId ?? "", user.id);
  if (!record || record.consumedAt) notFound();

  const session = await getUserSession(request);
  const csrf = session.get(CSRF_KEY) ?? randomBytes(32).toString("base64url");
  session.set(CSRF_KEY, csrf);

  return json(
    {
      tool: record.tool,
      target: await describeMcpSubject(record.subject),
      client: record.clientId
        ? await describeOAuthClientName(record.clientId)
        : "Personal access token",
      preview: record.preview,
      approved: record.approvedAt !== undefined,
      denied: record.deniedAt !== undefined,
      truncated: record.truncated === true,
      csrf,
    },
    { headers: { ...noStore, "Set-Cookie": await commitSession(session) } }
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const user = await requireUser(request);
  assertNotImpersonating(user);
  const session = await getUserSession(request);
  const expected = session.get(CSRF_KEY);
  const formData = await request.formData();
  const submitted = formData.get("csrf");
  if (
    typeof expected !== "string" ||
    typeof submitted !== "string" ||
    expected.length !== submitted.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))
  ) {
    throw new Response("Forbidden", { status: 403, headers: noStore });
  }

  const store = getMcpConfirmationStore();
  const id = params.confirmationId ?? "";
  const decision = formData.get("decision") ?? "approve";
  if (decision !== "approve" && decision !== "deny") {
    throw new Response("Bad Request", { status: 400, headers: noStore });
  }
  const logDecision = (record: { tool: string; subject?: { organizationId: string } | null }) =>
    logger.info("mcp.confirmation", {
      confirmationId: id,
      tool: record.tool,
      decision,
      userId: user.id,
      organizationId: record.subject?.organizationId,
    });
  if (decision === "deny") {
    const pending = await store.get(id, user.id);
    if (!(await store.deny(id, user.id))) notFound();
    if (pending) logDecision(pending);
    return json({ approved: false, denied: true, error: undefined }, { headers: noStore });
  }
  const record = await store.get(id, user.id);
  if (!record) notFound();
  if (record.truncated) {
    return json(
      { approved: false, denied: false, error: TOO_LARGE },
      { status: 422, headers: noStore }
    );
  }
  if (!(await store.approve(id, user.id))) notFound();
  if (!record.approvedAt) logDecision(record);
  return json({ approved: true, denied: false, error: undefined }, { headers: noStore });
}

export default function Page() {
  const { tool, target, client, preview, approved, denied, truncated, csrf } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  if (approved || result?.approved) {
    return (
      <Shell title="Approved">
        <Paragraph spacing className="text-center">
          Approved — return to your client and run the tool again.
        </Paragraph>
      </Shell>
    );
  }

  if (denied || result?.denied) {
    return (
      <Shell title="Denied">
        <Paragraph spacing className="text-center">
          Denied — nothing was run. If you change your mind, ask your assistant again in a minute.
        </Paragraph>
      </Shell>
    );
  }

  return (
    <Shell title={`Approve "${tool}"?`}>
      <Paragraph spacing className="text-center">
        {client} wants to run <strong>{tool}</strong> on {target}.
      </Paragraph>
      <CodeBlock
        code={preview}
        language="json"
        showLineNumbers={false}
        showOpenInModal={false}
        wrap
        maxLines={12}
        className="mb-4 w-full"
      />
      {truncated ? (
        <Paragraph className="text-center">{TOO_LARGE}</Paragraph>
      ) : (
        <Form method="post" className="flex w-full gap-6">
          <input type="hidden" name="csrf" value={csrf} />
          <Button
            type="submit"
            name="decision"
            value="deny"
            variant="secondary/large"
            fullWidth
            disabled={navigation.state !== "idle"}
          >
            Deny
          </Button>
          <Button
            type="submit"
            name="decision"
            value="approve"
            variant="primary/large"
            fullWidth
            disabled={navigation.state !== "idle"}
          >
            Approve
          </Button>
        </Form>
      )}
    </Shell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (!isRouteErrorResponse(error) || error.status !== 404) throw error;
  return (
    <Shell title="Confirmation link is no longer valid">
      <Paragraph className="text-center">
        This link was already used or has expired. Ask your assistant to run the action again to get
        a new link.
      </Paragraph>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <LoginPageLayout scrollable singleColumn>
      <div className="flex w-full flex-col items-center py-8">
        <Header1 className="pb-4 text-center font-semibold leading-tight text-2xl">{title}</Header1>
        {children}
      </div>
    </LoginPageLayout>
  );
}
