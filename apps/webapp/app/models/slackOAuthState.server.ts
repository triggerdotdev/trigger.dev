import { randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "~/env.server";
import { createRedisClient, type RedisClient } from "~/redis.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import { singleton } from "~/utils/singleton";

const STATE_TTL_SECONDS = 10 * 60;
const CREATE_ATTEMPTS = 2;
const KEY_PREFIX = "oauth:slack:state:";
const SLACK_OAUTH_SESSION_BINDING_KEY = "slack-oauth-session-binding";

const SlackOAuthStateSchema = z.object({
  userId: z.string(),
  sessionBinding: z.string(),
  organizationId: z.string(),
  service: z.literal("slack"),
  redirectTo: z.string().regex(/^\/(?!\/)/),
});

export type SlackOAuthState = z.infer<typeof SlackOAuthStateSchema>;

type CreateSlackOAuthState = SlackOAuthState;
type StartSlackOAuthState = Omit<CreateSlackOAuthState, "sessionBinding">;
type ConsumeSlackOAuthState = Pick<SlackOAuthState, "userId" | "sessionBinding" | "service">;

const consumeScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local decoded, state = pcall(cjson.decode, raw)
if not decoded or type(state) ~= "table" then return nil end
if state.userId ~= ARGV[1] or state.sessionBinding ~= ARGV[2] or state.service ~= ARGV[3] then
  return nil
end
redis.call("DEL", KEYS[1])
return raw
`;

export class SlackOAuthStateStore {
  constructor(private readonly redis: Pick<RedisClient, "set" | "eval">) {}

  async create(state: CreateSlackOAuthState): Promise<string> {
    const parsedState = SlackOAuthStateSchema.parse(state);

    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      const nonce = randomBytes(32).toString("base64url");
      const created = await this.redis.set(
        this.#key(nonce),
        JSON.stringify(parsedState),
        "EX",
        STATE_TTL_SECONDS,
        "NX"
      );
      if (created === "OK") return nonce;
    }

    throw new Error("Failed to create a unique Slack OAuth state");
  }

  async consume(
    nonce: string,
    expected: ConsumeSlackOAuthState
  ): Promise<SlackOAuthState | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return undefined;

    const raw = await this.redis.eval(
      consumeScript,
      1,
      this.#key(nonce),
      expected.userId,
      expected.sessionBinding,
      expected.service
    );
    if (typeof raw !== "string") return undefined;

    try {
      return SlackOAuthStateSchema.safeParse(JSON.parse(raw)).data;
    } catch {
      return undefined;
    }
  }

  #key(nonce: string): string {
    return `${KEY_PREFIX}{${nonce}}`;
  }
}

export async function createSlackOAuthStateForSession(
  request: Request,
  state: StartSlackOAuthState,
  stateStore: SlackOAuthStateStore = getSlackOAuthStateStore()
): Promise<{ nonce: string; sessionCookie: string }> {
  const session = await getUserSession(request);
  const sessionBinding = randomBytes(32).toString("base64url");
  const nonce = await stateStore.create({ ...state, sessionBinding });
  session.set(SLACK_OAUTH_SESSION_BINDING_KEY, sessionBinding);

  return { nonce, sessionCookie: await commitSession(session) };
}

export async function consumeSlackOAuthStateForSession(
  request: Request,
  nonce: string,
  userId: string,
  stateStore: SlackOAuthStateStore = getSlackOAuthStateStore()
): Promise<SlackOAuthState | undefined> {
  const session = await getUserSession(request);
  const sessionBinding = session.get(SLACK_OAUTH_SESSION_BINDING_KEY);
  if (typeof sessionBinding !== "string") return undefined;

  return stateStore.consume(nonce, { userId, sessionBinding, service: "slack" });
}

export async function clearSlackOAuthSessionBinding(request: Request): Promise<string> {
  const session = await getUserSession(request);
  session.unset(SLACK_OAUTH_SESSION_BINDING_KEY);
  return commitSession(session);
}

function getSlackOAuthStateStore(): SlackOAuthStateStore {
  if (!env.CACHE_REDIS_HOST) {
    throw new Error("Cache Redis is required for Slack OAuth state");
  }

  return singleton(
    "slackOAuthStateStore",
    () =>
      new SlackOAuthStateStore(
        createRedisClient("trigger:slack-oauth-state", {
          host: env.CACHE_REDIS_HOST,
          port: env.CACHE_REDIS_PORT,
          username: env.CACHE_REDIS_USERNAME,
          password: env.CACHE_REDIS_PASSWORD,
          tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
          clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
        })
      )
  );
}
