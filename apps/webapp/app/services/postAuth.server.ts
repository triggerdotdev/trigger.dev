import { createFirstOrganization } from "~/models/organization.server";
import type { User } from "~/models/user.server";
import * as emailProvider from "~/services/email.server";
import { analytics } from "./analytics.server";
import { taskQueue } from "./messageBroker.server";

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
    await createFirstOrganization(user);
    await emailProvider.scheduleWelcomeEmail(user);

    await taskQueue.publish("SEND_INTERNAL_EVENT", {
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
