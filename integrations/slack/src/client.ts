import { ClientFactory } from "@trigger.dev/sdk";
import { WebClient } from "@slack/web-api";

export const clientFactory: ClientFactory<InstanceType<typeof WebClient>> = (
  auth
) => {
  console.log("Creating slack client", auth);

  return new WebClient(auth.accessToken);
};
