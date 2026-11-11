import type { User } from "~/models/user.server";
import { isSessionValid } from "./accessPolicy.server";
import { logger } from "./logger.server";
import { telemetry } from "./telemetry.server";

export async function postAuthentication({
  user,
  loginMethod,
  isNewUser,
}: {
  user: User;
  loginMethod: User["authenticationMethod"];
  isNewUser: boolean;
}) {
  if (!(await isSessionValid({ userId: user.id, issuedAt: Date.now() }))) {
    logger.warn("Sign-in refused", { event: "auth.refused", userId: user.id, loginMethod });
    throw new Error("This account has been disabled.");
  }

  telemetry.user.identify({
    user,
    isNewUser,
  });
}
