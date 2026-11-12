import { ShieldCheckIcon } from "@heroicons/react/24/solid";
import {
  json,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Paragraph } from "~/components/primitives/Paragraph";
import { describeMcpSubject } from "~/mcp/confirm/confirmation.server";
import { getMcpConfirmationStore } from "~/mcp/confirm/storeInstance.server";
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
  const record = await getMcpConfirmationStore().get(params.confirmationId ?? "", user.id);
  if (!record || record.consumedAt) notFound();

  const session = await getUserSession(request);
  const csrf = session.get(CSRF_KEY) ?? randomBytes(32).toString("base64url");
  session.set(CSRF_KEY, csrf);

  return json(
    {
      tool: record.tool,
      target: await describeMcpSubject(record.subject),
      client: record.clientId ?? "Personal access token",
      preview: record.preview,
      approved: record.approvedAt !== undefined,
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
  const session = await getUserSession(request);
  const expected = session.get(CSRF_KEY);
  const submitted = (await request.formData()).get("csrf");
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
  const record = await store.get(id, user.id);
  if (!record) notFound();
  if (record.truncated) {
    return json({ approved: false, error: TOO_LARGE }, { status: 422, headers: noStore });
  }
  if (!(await store.approve(id, user.id))) notFound();
  return json({ approved: true, error: undefined }, { headers: noStore });
}

export default function Page() {
  const { tool, target, client, preview, approved, truncated, csrf } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();

  if (approved || result?.approved) {
    return (
      <Shell title="Approved">
        <Paragraph spacing>Approved — return to your client and run the tool again.</Paragraph>
      </Shell>
    );
  }

  return (
    <Shell title={`Approve "${tool}"?`}>
      <Paragraph spacing>
        {client} wants to run <strong>{tool}</strong> on {target}.
      </Paragraph>
      <pre className="mb-4 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-charcoal-800 p-3 font-mono text-xs text-text-dimmed">
        {preview}
      </pre>
      {truncated ? (
        <Paragraph>{TOO_LARGE}</Paragraph>
      ) : (
        <Form method="post">
          <input type="hidden" name="csrf" value={csrf} />
          <Button variant="primary/medium" disabled={navigation.state !== "idle"}>
            Approve
          </Button>
        </Form>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <AppContainer>
      <MainCenteredContainer className="max-w-120">
        <div>
          <FormTitle
            LeadingIcon={<ShieldCheckIcon className="size-6 text-cyan-500" />}
            title={title}
          />
          {children}
        </div>
      </MainCenteredContainer>
    </AppContainer>
  );
}
