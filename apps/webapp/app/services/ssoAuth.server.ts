import type { SessionStorage } from "@remix-run/server-runtime";
import type { AuthenticateOptions, Authenticator } from "remix-auth";
import { Strategy } from "remix-auth";
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
    try {
      const user = await this.verify(ctx);
      return this.success(user, request, sessionStorage, options);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return this.failure(cause.message, request, sessionStorage, options, cause);
    }
  }
}

export function addSsoStrategy(authenticator: Authenticator<AuthUser>) {
  authenticator.use(
    new SsoStrategy(async ({ profile, flow }) => {
      const decision = await ssoController.resolveSsoIdentity({ profile });
      if (decision.isErr()) {
        // Surfaces "feature_disabled" in OSS deployments. The callback
        // route's error path translates this into a generic
        // sign-in-failed user-facing message.
        throw new Error(`SSO resolve failed: ${decision.error}`);
      }

      const value = decision.value;

      let userId: string;
      let isNewUser = false;

      if (value.kind === "create_new_user") {
        const created = await findOrCreateSsoUser({
          authenticationMethod: "SSO",
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
        });
        userId = created.user.id;
        isNewUser = created.isNewUser;
      } else {
        userId = value.userId;
      }

      // Best-effort: attaching the IdP identity row is an optimisation
      // for the next login (it lets resolveSsoIdentity take the
      // existing_user_by_idp fast path instead of falling back to
      // linked_by_email). The user is already authenticated by this
      // point, so we log and continue rather than failing the sign-in;
      // a later successful login will write the row.
      const attach = await ssoController.attachSsoIdentity({ userId, profile });
      if (attach.isErr()) {
        logger.warn("SSO attachSsoIdentity failed", {
          reason: attach.error,
          userId,
          flow,
        });
      }

      const jit = await ssoController.evaluateJit({
        userId,
        idpOrgId: profile.idpOrgId,
      });
      if (jit.isOk() && jit.value.shouldProvision) {
        const result = await ensureOrgMember({
          userId,
          organizationId: jit.value.organizationId,
          roleId: jit.value.roleId,
          source: "sso_jit",
        });
        if (!result.created) {
          logger.info("SSO JIT skipped — membership already exists", {
            userId,
            organizationId: jit.value.organizationId,
          });
        }
      } else if (jit.isErr() && jit.error !== "feature_disabled") {
        logger.warn("SSO evaluateJit failed", { reason: jit.error, userId, flow });
      }

      const user = await prisma.user.findFirst({ where: { id: userId } });
      if (user) {
        await postAuthentication({
          user,
          isNewUser,
          loginMethod: "SSO",
        });
      }

      return { userId };
    }),
    "sso"
  );
}
