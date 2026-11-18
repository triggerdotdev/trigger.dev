import { describe, expect, it } from "vitest";
import { generateJWT, validateJWT } from "../src/v3/jwt.js";

const SECRET = "test-secret";
const MCP_AUDIENCE = "https://mcp.example/mcp";

describe("JWT audience", () => {
  it.each([
    { signWith: undefined, verifyWith: undefined, ok: true },
    { signWith: MCP_AUDIENCE, verifyWith: undefined, ok: false },
    { signWith: MCP_AUDIENCE, verifyWith: MCP_AUDIENCE, ok: true },
    { signWith: undefined, verifyWith: MCP_AUDIENCE, ok: false },
  ])(
    "signed for $signWith, verified for $verifyWith -> ok: $ok",
    async ({ signWith, verifyWith, ok }) => {
      const token = await generateJWT({ secretKey: SECRET, payload: {}, audience: signWith });
      const result = await validateJWT(token, SECRET, verifyWith);
      expect(result.ok).toBe(ok);
    }
  );

  it("rejects an empty audience", async () => {
    const token = await generateJWT({ secretKey: SECRET, payload: {} });
    await expect(validateJWT(token, SECRET, "")).rejects.toThrow();
  });
});
