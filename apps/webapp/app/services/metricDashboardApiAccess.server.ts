import { json } from "@remix-run/server-runtime";
import { $replica } from "~/db.server";
import type { ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { queryScopeCeilingFor } from "~/v3/queryScope";

export async function assertDashboardApiAccess(
  authentication: Pick<
    ApiAuthenticationResultSuccess,
    "type" | "credentialKind" | "actor" | "environment"
  >
): Promise<void> {
  if (queryScopeCeilingFor(authentication) === "unbounded") return;

  // PAT-exchanged JWTs used by MCP carry a signed actor, not a browser-supplied header.
  // Run-token public minting cannot set act. Root-key holders can, but already have org access.
  if (authentication.type === "PUBLIC_JWT" && authentication.actor) {
    const member = await $replica.orgMember.findFirst({
      where: {
        organizationId: authentication.environment.organizationId,
        userId: authentication.actor.sub,
      },
      select: { id: true },
    });
    if (member) return;
  }

  throw json(
    { error: "Query dashboard APIs require an API key or a delegated organization member." },
    { status: 403 }
  );
}
