import type { User } from "~/models/user.server";
import * as emailProvider from "~/services/email.server";
import { analytics } from "./analytics.server";
import { workerQueue } from "./worker.server";

export async function postAuthentication({
  user,
  loginMethod,
  isNewUser,
}: {
  user: User;
  loginMethod: User["authenticationMethod"];
  isNewUser: boolean;
}) {
  if (isNewUser) {
    await emailProvider.scheduleWelcomeEmail(user);
  }

  analytics.user.identify({ user, isNewUser });
}
