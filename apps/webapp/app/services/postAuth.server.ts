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

    await workerQueue.enqueue("sendInternalEvent", {
      id: user.id,
      name: "user.created",
      payload: {
        id: user.id,
        source: loginMethod,
        admin: user.admin,
      },
    });
  }

  analytics.user.identify({ user, isNewUser });
}
