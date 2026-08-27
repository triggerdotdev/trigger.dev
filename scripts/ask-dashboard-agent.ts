#!/usr/bin/env tsx

/**
 * Asks the in-dashboard agent a question, headlessly, and prints the finished transcript.
 * Companion script for UAT scenarios that need to drive the agent without a browser.
 *
 * AUTH: drives the real local magic-link login over HTTP instead of minting a session
 * cookie by hand. In development `sendMagicLinkEmail` (apps/webapp/app/services/email.server.ts)
 * throws a redirect straight to the magic link instead of sending an email - the same
 * shortcut the chrome-devtools login flow documented in apps/webapp/CLAUDE.md relies on. The
 * strategy's magic-link token is self-contained (email + issue time, AES-encrypted with
 * MAGIC_LINK_SECRET - see remix-auth-email-link's `validateMagicLink`) and, since this repo
 * never sets `validateSessionMagicLink`, verifying it does not require the session cookie
 * that carried it in a browser. So the two POST/GET calls below don't need any secret this
 * script would otherwise have to read out of the webapp's env - just the two HTTP hops a
 * browser makes, which is more robust than replicating `sessionStorage.server.ts`'s cookie
 * signing here.
 *
 * ASK: replicates the calls `DashboardAgentPanel`/`DashboardAgentChat` make against
 * `resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.ts`:
 * `intent=create` (or `intent=start` to resume a chat with `--chat`) starts the turn. Locally
 * ANTHROPIC_API_KEY is set, so `create` head-starts the run server-side and dispatches the
 * first message itself - no need to also drive the `.in` AI-SDK proxy the browser's streaming
 * transport uses. Settlement is read back exactly the way `settled-transcript.ts` decides a
 * turn is still open: `transcriptLooksUnfinished` (an in-flight `tool-*` part on the last
 * assistant message, or an investigation block whose outcome is still `in_progress`).
 *
 * USAGE:
 *   pnpm exec tsx scripts/ask-dashboard-agent.ts \
 *     --org references-0eb0 --project hello-world-jpz1 --env dev \
 *     --message "What failed in the last hour?" \
 *     [--user katia+test@trigger.dev] [--chat chat_xxx] [--base-url http://localhost:3030] \
 *     [--timeout 120]
 *
 * FLAGS:
 *   --org, --project, --env   slugs, same as the dashboard URL
 *   --message                 the question to ask
 *   --user                    who's asking (default: katia+test@trigger.dev)
 *   --chat                    resume an existing chat instead of starting a new one
 *   --base-url                webapp origin (default: http://localhost:3030)
 *   --timeout                 seconds to wait for the turn to settle (default: 120)
 *
 * The dashboard agent must be enabled for the org (`hasDashboardAgentAccess` feature flag,
 * or `DASHBOARD_AGENT_ADMIN_PREVIEW=1` with an admin user) or `create`/`start` 501 with
 * "The dashboard agent is not configured."
 */

type Part = { type?: string; state?: string; text?: string; output?: unknown };
type UIMessage = { id: string; role: string; parts?: Part[] };

type Args = {
  org: string;
  project: string;
  env: string;
  message: string;
  user: string;
  chat?: string;
  baseUrl: string;
  timeoutSeconds: number;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const org = get("--org");
  const project = get("--project");
  const env = get("--env");
  const message = get("--message");
  if (!org || !project || !env || !message) {
    console.error(
      "Usage: pnpm exec tsx scripts/ask-dashboard-agent.ts --org <slug> --project <slug> --env <slug> --message <text> [--user <email>] [--chat <id>] [--base-url <url>] [--timeout <seconds>]"
    );
    process.exit(1);
  }

  return {
    org,
    project,
    env,
    message,
    user: get("--user") ?? "katia+test@trigger.dev",
    chat: get("--chat"),
    baseUrl: get("--base-url") ?? "http://localhost:3030",
    timeoutSeconds: Number(get("--timeout") ?? "120"),
  };
}

// ---------------------------------------------------------------------------
// Cookie jar - just enough to carry the session cookie across the login hops
// and every subsequent call. `fetch`'s automatic cookie handling only spans a
// single call, so requests here are all `redirect: "manual"` and forwarded by hand.
// ---------------------------------------------------------------------------

class CookieJar {
  private cookies = new Map<string, string>();

  absorb(res: Response) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function loginViaMagicLink(baseUrl: string, email: string): Promise<CookieJar> {
  const jar = new CookieJar();

  // Step 1: request the link. Dev mode short-circuits email delivery into a 302
  // whose Location is the magic link itself.
  const sendBody = new URLSearchParams({ action: "send", email });
  const sendRes = await fetch(`${baseUrl}/login/magic`, {
    method: "POST",
    body: sendBody,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  jar.absorb(sendRes);
  const magicLink = sendRes.headers.get("location");
  if (sendRes.status !== 302 || !magicLink) {
    throw new Error(
      `Magic link request didn't redirect (status ${sendRes.status}). Is NODE_ENV=development on the webapp?`
    );
  }

  // Step 2: "click" the link. The callback verifies the token, sets the authenticated
  // session cookie, and redirects home.
  const magicRes = await fetch(magicLink, {
    redirect: "manual",
    headers: { Cookie: jar.header() },
  });
  jar.absorb(magicRes);
  if (magicRes.status !== 302) {
    throw new Error(`Magic link verify didn't redirect (status ${magicRes.status}).`);
  }
  if (!jar.header()) {
    throw new Error("Magic link verify produced no session cookie.");
  }

  return jar;
}

// ---------------------------------------------------------------------------
// Dashboard-agent resource route calls
// ---------------------------------------------------------------------------

function actionPath(baseUrl: string, org: string, project: string, env: string): string {
  return `${baseUrl}/resources/orgs/${org}/projects/${project}/env/${env}/dashboard-agent`;
}

async function postForm(
  url: string,
  jar: CookieJar,
  fields: Record<string, string>
): Promise<{ status: number; body: any }> {
  const body = new URLSearchParams(fields);
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
  });
  jar.absorb(res);
  const body_ = await res.json().catch(() => ({}));
  return { status: res.status, body: body_ };
}

async function getJson(url: string, jar: CookieJar): Promise<any> {
  const res = await fetch(url, { headers: { Cookie: jar.header() } });
  jar.absorb(res);
  return res.json().catch(() => ({}));
}

/** Same criteria `settled-transcript.ts` uses client-side, after its stream closes. */
function transcriptLooksUnfinished(messages: UIMessage[]): boolean {
  // An investigation block (from a `tool-render_view` output) whose latest revision is
  // still `in_progress`.
  const latest = new Map<string, { revision: number; outcome?: string }>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== "tool-render_view") continue;
      const blocks = (part.output as { blocks?: unknown[] } | undefined)?.blocks;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks as Array<{
        type?: string;
        id?: string;
        revision?: number;
        investigation?: { outcome?: string };
      }>) {
        if (block?.type !== "investigation" || typeof block.id !== "string") continue;
        const revision = typeof block.revision === "number" ? block.revision : 0;
        const current = latest.get(block.id);
        if (!current || revision >= current.revision) {
          latest.set(block.id, { revision, outcome: block.investigation?.outcome });
        }
      }
    }
  }
  if ([...latest.values()].some((block) => block.outcome === "in_progress")) return true;

  // An in-flight tool part on the last message, if it's an assistant turn.
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return false;
  const inFlightStates = new Set(["input-streaming", "input-available"]);
  return (last.parts ?? []).some(
    (part) =>
      typeof part.type === "string" &&
      part.type.startsWith("tool-") &&
      inFlightStates.has(part.state ?? "")
  );
}

function toolCallsInOrder(messages: UIMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (typeof part.type === "string" && part.type.startsWith("tool-")) {
        names.push(part.type.slice("tool-".length));
      }
    }
  }
  return names;
}

function investigationCards(
  messages: UIMessage[]
): Array<{ id: string; revision: number; outcome?: string; severity?: string }> {
  const latest = new Map<
    string,
    { id: string; revision: number; outcome?: string; severity?: string }
  >();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== "tool-render_view") continue;
      const blocks = (part.output as { blocks?: unknown[] } | undefined)?.blocks;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks as Array<{
        type?: string;
        id?: string;
        revision?: number;
        investigation?: { outcome?: string; severity?: string };
      }>) {
        if (block?.type !== "investigation" || typeof block.id !== "string") continue;
        const revision = typeof block.revision === "number" ? block.revision : 0;
        const current = latest.get(block.id);
        if (!current || revision >= current.revision) {
          latest.set(block.id, {
            id: block.id,
            revision,
            outcome: block.investigation?.outcome,
            severity: block.investigation?.severity,
          });
        }
      }
    }
  }
  return [...latest.values()];
}

function finalAssistantText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    return (message.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = Date.now();

  console.log(`Logging in as ${args.user}...`);
  const jar = await loginViaMagicLink(args.baseUrl, args.user);

  const path = actionPath(args.baseUrl, args.org, args.project, args.env);
  let chatId = args.chat;

  if (!chatId) {
    console.log("Creating chat...");
    const firstMessage: UIMessage = {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      role: "user",
      parts: [{ type: "text", text: args.message }],
    };
    const { status, body } = await postForm(path, jar, {
      intent: "create",
      message: JSON.stringify(firstMessage),
    });
    if (status !== 200 || !body.chatId) {
      console.error(`create failed (status ${status}):`, body);
      process.exit(1);
    }
    chatId = body.chatId;
    console.log(`Chat ${chatId} started (headStarted=${body.headStarted})`);
  } else {
    console.log(`Resuming chat ${chatId}...`);
    // `start` only resumes an existing session; sending a follow-up message on an
    // already-running chat isn't exposed by this route without the `.in` AI-SDK proxy the
    // browser's streaming transport uses, so `--chat` is for polling a chat already in flight.
    const { status, body } = await postForm(path, jar, { intent: "start", chatId });
    if (status !== 200) {
      console.error(`start failed (status ${status}):`, body);
      process.exit(1);
    }
  }

  console.log(`Waiting for the turn to settle (up to ${args.timeoutSeconds}s)...`);
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  let messages: UIMessage[] = [];
  let settled = false;
  while (Date.now() < deadline) {
    const data = await getJson(`${path}?chatId=${encodeURIComponent(chatId)}`, jar);
    if (Array.isArray(data.messages)) {
      messages = data.messages;
      if (messages.length > 0 && !transcriptLooksUnfinished(messages)) {
        settled = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const elapsedMs = Date.now() - start;
  const quota = await getJson(`${path}?quota=1`, jar);

  console.log("\n=== Transcript ===");
  for (const message of messages) {
    console.log(`[${message.role}] ${message.id}`);
  }

  console.log("\n=== Tool calls (in order) ===");
  console.log(toolCallsInOrder(messages).join(", ") || "(none)");

  const cards = investigationCards(messages);
  if (cards.length > 0) {
    console.log("\n=== Investigation cards ===");
    for (const card of cards) {
      console.log(
        `${card.id} rev=${card.revision} outcome=${card.outcome} severity=${card.severity}`
      );
    }
  }

  console.log("\n=== Final assistant message ===");
  console.log(finalAssistantText(messages) || "(no text)");

  console.log(`\n=== Timing ===`);
  console.log(`chatId=${chatId} elapsed=${elapsedMs}ms settled=${settled}`);
  if (typeof quota.used === "number") {
    console.log(
      `quota used=${quota.used}${quota.limit != null ? ` limit=${quota.limit}` : " (unlimited)"}`
    );
  }

  if (!settled) {
    console.error(`\nTimed out after ${args.timeoutSeconds}s waiting for the turn to settle.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
