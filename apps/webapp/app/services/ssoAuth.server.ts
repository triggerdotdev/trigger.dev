import type { SessionStorage } from "@remix-run/server-runtime";
import type { AuthenticateOptions, Authenticator } from "remix-auth";
import { Strategy } from "remix-auth";
import { tryCatch } from "@trigger.dev/core/v3";
import type { SsoFlow, SsoProfile } from "@trigger.dev/plugins";
import { prisma } from "~/db.server";
import { ensureOrgMember } from "~/models/orgMember.server";
import { findOrCreateSsoUser } from "~/models/user.server";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";
import { postAuthentication } from "./postAuth.server";
import { ssoController } from "./sso.server";

export type SsoVerifyParams = {
  profile: SsoProfile;
  flow: SsoFlow;
};

// Hybrid remix-auth strategy. The strategy is invoked by the callback
// route AFTER it has performed the SSO code exchange via the plugin —
// the route passes the verified profile + flow through
// `authenticator.authenticate("sso", request, { context })`. The
// strategy reads that context and runs the user-resolution side of the
// flow (plugin identity lookups + host-side User/OrgMember writes).
//
// In an OSS deployment with no SSO plugin installed, the plugin's
// `resolveSsoIdentity` returns `feature_disabled` from the fallback,
// which propagates here as a failure. That's the expected behaviour:
// without the plugin there is no callback route invoking the strategy
// in the first place.
class SsoStrategy extends Strategy<AuthUser, SsoVerifyParams> {
  name = "sso";

  async authenticate(
    request: Request,
    sessionStorage: SessionStorage,
    options: AuthenticateOptions
  ): Promise<AuthUser> {
    const ctx = (options.context ?? undefined) as SsoVerifyParams | undefined;
    if (!ctx?.profile || !ctx?.flow) {
      return this.failure(
        "SSO strategy invoked without profile context",
        request,
        sessionStorage,
        options
      );
    }
    const [error, user] = await tryCatch(this.verify(ctx));
    if (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return this.failure(cause.message, request, sessionStorage, options, cause);
    }
    return this.success(user, request, sessionStorage, options);
  }
}

// Resolve the host User for a verified SSO profile, creating one on the
// `create_new_user` decision. Throws on an errored decision — this surfaces
// "feature_disabled" in OSS deployments, which the callback route's error
// path translates into a generic sign-in-failed user-facing message.
async function resolveSsoUserId(
  profile: SsoProfile
): Promise<{ userId: string; isNewUser: boolean }> {
  const decision = await ssoController.resolveSsoIdentity({ profile });
  if (decision.isErr()) {
    throw new Error(`SSO resolve failed: ${decision.error}`);
  }

  if (decision.value.kind === "create_new_user") {
    const created = await findOrCreateSsoUser({
      authenticationMethod: "SSO",
      email: profile.email,
      firstName: profile.firstName,
      lastName: profile.lastName,
    });
    return { userId: created.user.id, isNewUser: created.isNewUser };
  }

  return { userId: decision.value.userId, isNewUser: false };
}

// Best-effort: attaching the IdP identity row is an optimisation for the
// next login (it lets resolveSsoIdentity take the existing_user_by_idp fast
// path instead of falling back to linked_by_email). The user is already
// authenticated by this point, so we log and continue rather than failing
// the sign-in; a later successful login will write the row.
async function attachSsoIdentityBestEffort(
  userId: string,
  profile: SsoProfile,
  flow: SsoFlow
): Promise<void> {
  const attach = await ssoController.attachSsoIdentity({ userId, profile });
  if (attach.isErr()) {
    logger.warn("SSO attachSsoIdentity failed", { reason: attach.error, userId, flow });
  }
}

// Best-effort JIT org provisioning. Like attachSsoIdentity above, a failure
// must not block an otherwise-valid sign-in: the user simply isn't
// provisioned this time and a later login retries. "feature_disabled" is the
// expected OSS-fallback result, so it's swallowed silently.
async function provisionJitMembershipBestEffort(
  userId: string,
  profile: SsoProfile,
  flow: SsoFlow
): Promise<void> {
  const jit = await ssoController.evaluateJit({ userId, idpOrgId: profile.idpOrgId });
  if (jit.isErr()) {
    if (jit.error !== "feature_disabled") {
      logger.warn("SSO evaluateJit failed", { reason: jit.error, userId, flow });
    }
    return;
  }

  if (!jit.value.shouldProvision) return;

  const [provisionError, result] = await tryCatch(
    ensureOrgMember({
      userId,
      organizationId: jit.value.organizationId,
      roleId: jit.value.roleId,
      source: "sso_jit",
    })
  );
  if (provisionError) {
    // e.g. the RBAC role couldn't be applied, so ensureOrgMember rolled back
    // the membership.
    logger.warn("SSO JIT provisioning failed", {
      reason: provisionError instanceof Error ? provisionError.message : String(provisionError),
      userId,
      organizationId: jit.value.organizationId,
      flow,
    });
    return;
  }

  if (!result.created) {
    logger.info("SSO JIT skipped — membership already exists", {
      userId,
      organizationId: jit.value.organizationId,
    });
  }
}

async function runPostAuthentication(userId: string, isNewUser: boolean): Promise<void> {
  const user = await prisma.user.findFirst({ where: { id: userId } });
  if (!user) {
    // The user was just resolved or created above, so a null here means it
    // was hard-deleted mid-flow (or a DB inconsistency). Fail closed — throw
    // rather than skipping postAuthentication and still returning a valid
    // AuthUser, which would mint a session for a user we can't confirm.
    throw new Error(`SSO user not found after resolution: ${userId}`);
  }
  await postAuthentication({ user, isNewUser, loginMethod: "SSO" });
}

export function addSsoStrategy(authenticator: Authenticator<AuthUser>) {
  authenticator.use(
    new SsoStrategy(async ({ profile, flow }) => {
      const { userId, isNewUser } = await resolveSsoUserId(profile);

      await attachSsoIdentityBestEffort(userId, profile, flow);
      await provisionJitMembershipBestEffort(userId, profile, flow);
      await runPostAuthentication(userId, isNewUser);

      // Carry the SSO marker on the returned AuthUser so the session is
      // self-describing — `revalidateSsoSession()` keys off `AuthUser.sso`,
      // and relying on the callback route to re-attach it would silently
      // disable revalidation for any other caller of this strategy.
      return {
        userId,
        sso: { idpOrgId: profile.idpOrgId, connectionId: profile.idpConnectionId },
      };
    }),
    "sso"
  );
}
