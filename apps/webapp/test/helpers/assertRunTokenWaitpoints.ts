import type { PrismaClient, RuntimeEnvironment } from "@trigger.dev/database";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { seedTestEnvironment } from "./seedTestEnvironment";

export async function assertRunTokenWaitpoints(
  prisma: PrismaClient,
  tokenFor: (environment: RuntimeEnvironment) => Promise<string>
) {
  const { action: create } = await import("~/routes/api.v1.waitpoints.tokens");
  const { action: callback } =
    await import("~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.callback.$hash");
  const { loader: retrieve } =
    await import("~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId");
  const { generateHttpCallbackUrl } = await import("~/services/httpCallback.server");
  const { handlePublicTokenRequest } = await import("~/services/publicTokens.server");
  const { action: completeWithAuth } =
    await import("~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.complete");

  for (const type of ["PREVIEW", "PRODUCTION"] as const) {
    const seed = await seedTestEnvironment(prisma);
    const parent = await prisma.runtimeEnvironment.update({
      where: { id: seed.environment.id },
      data: { type, slug: type === "PREVIEW" ? "preview" : "prod" },
    });
    const environment =
      type === "PREVIEW"
        ? await prisma.runtimeEnvironment.create({
            data: {
              organizationId: parent.organizationId,
              projectId: parent.projectId,
              type,
              slug: "preview-feature",
              branchName: "feature",
              shortcode: "feature",
              parentEnvironmentId: parent.id,
              apiKey: `${parent.apiKey}_branch`,
              pkApiKey: `${parent.pkApiKey}_branch`,
            },
          })
        : parent;
    const bearer = await tokenFor(environment);
    const headers = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
    const created = await create({
      request: new Request("https://api.example.com/api/v1/waitpoints/tokens", {
        method: "POST",
        headers: { ...headers, "Content-Length": "2" },
        body: JSON.stringify({}),
      }),
      params: {},
      context: {},
    });
    expect(created.status).toBe(200);
    const token = (await created.json()) as { id: string; url: string };
    const waitpointId = WaitpointId.toId(token.id);
    expect(await prisma.waitpoint.findFirst({ where: { id: waitpointId } })).toMatchObject({
      environmentId: environment.id,
      status: "PENDING",
    });

    async function complete(url: string) {
      const hash = new URL(url).pathname.split("/").pop()!;
      return callback({
        request: new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": "17" },
          body: JSON.stringify({ approved: true }),
        }),
        params: { waitpointFriendlyId: token.id, hash },
        context: {},
      });
    }

    // Catches: preview run-token creation signing with the branch key instead of the parent key.
    expect(token.url).toBe(generateHttpCallbackUrl(waitpointId, parent.apiKey));
    // Catches: callback compatibility allowing unrelated keys to complete a waitpoint.
    expect((await complete(generateHttpCallbackUrl(waitpointId, "unrelated-key"))).status).toBe(
      401
    );
    expect((await complete(token.url)).status).toBe(200);
    const result = await retrieve({
      request: new Request(`https://api.example.com/api/v1/waitpoints/tokens/${token.id}`, {
        headers,
      }),
      params: { waitpointFriendlyId: token.id },
      context: {},
    });
    expect(result.status).toBe(200);
    const completed = (await result.json()) as { status: string; output: string };
    expect(completed).toMatchObject({ status: "COMPLETED" });
    expect(JSON.parse(completed.output!)).toMatchObject({ json: { approved: true } });

    if (type === "PREVIEW") {
      // Catches: already-issued branch-key callback URLs remaining unusable after auth normalization.
      const old = await create({
        request: new Request("https://api.example.com/api/v1/waitpoints/tokens", {
          method: "POST",
          headers: { ...headers, "Content-Length": "2" },
          body: JSON.stringify({}),
        }),
        params: {},
        context: {},
      });
      expect(old.status).toBe(200);
      const oldToken = (await old.json()) as { id: string };
      const oldId = WaitpointId.toId(oldToken.id);
      const oldUrl = generateHttpCallbackUrl(oldId, environment.apiKey);
      const response = await callback({
        request: new Request(oldUrl, { method: "POST", headers: { "Content-Length": "0" } }),
        params: {
          waitpointFriendlyId: oldToken.id,
          hash: new URL(oldUrl).pathname.split("/").pop()!,
        },
        context: {},
      });
      expect(response.status).toBe(200);
      expect(await prisma.waitpoint.findFirst({ where: { id: oldId } })).toMatchObject({
        status: "COMPLETED",
      });
    }

    // Catches: changing run-token signing keys breaking the public JWTs they mint for branch envs.
    const minted = await handlePublicTokenRequest(
      new Request("https://api.example.com/api/v1/auth/public-tokens", {
        method: "POST",
        headers,
        body: JSON.stringify({ scopes: [`write:waitpoints:${token.id}`] }),
      })
    );
    expect(minted.status).toBe(200);
    const mintedBody = await minted.json();
    if ("error" in mintedBody) throw new Error(mintedBody.error);
    const publicToken = mintedBody.token;
    const publicResult = await completeWithAuth({
      request: new Request(
        `https://api.example.com/api/v1/waitpoints/tokens/${token.id}/complete`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${publicToken}`,
            "Content-Type": "application/json",
            "Content-Length": "2",
          },
          body: JSON.stringify({}),
        }
      ),
      params: { waitpointFriendlyId: token.id },
      context: {},
    });
    expect(publicResult.status).toBe(200);
    expect(await publicResult.json()).toMatchObject({ success: true });
  }
}
