import { signUserActorToken, verifyUserActorToken } from "@trigger.dev/plugins";
import { expect, test } from "vitest";

const SECRET = "test-user-actor-secret";
const MCP_AUDIENCE = "https://mcp.example/mcp";

test.each([
  { signWith: undefined, verifyWith: undefined, ok: true },
  { signWith: MCP_AUDIENCE, verifyWith: undefined, ok: false },
  { signWith: MCP_AUDIENCE, verifyWith: MCP_AUDIENCE, ok: true },
  { signWith: undefined, verifyWith: MCP_AUDIENCE, ok: false },
])(
  "verifyUserActorToken: signed for $signWith, verified for $verifyWith -> ok: $ok",
  async ({ signWith, verifyWith, ok }) => {
    const token = await signUserActorToken(SECRET, {
      userId: "usr_1",
      client: "test",
      audience: signWith,
    });
    const claims = await verifyUserActorToken(SECRET, token, { audience: verifyWith });
    expect(claims?.userId).toBe(ok ? "usr_1" : undefined);
  }
);
