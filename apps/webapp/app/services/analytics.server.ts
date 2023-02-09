import { PostHog } from "posthog-node";
import { env } from "~/env.server";
import type { User } from "~/models/user.server";

class BehaviouralAnalytics {
  client: PostHog | undefined = undefined;

  constructor(apiKey?: string) {
    if (!apiKey) {
      console.log("No PostHog API key, so analytics won't track");
      return;
    }
    this.client = new PostHog(apiKey, { host: "https://app.posthog.com" });
  }

  identify(user: User, isNewUser: boolean) {
    if (this.client === undefined) return;
    this.client.identify({
      distinctId: user.id,
      properties: {
        email: user.email,
        name: user.name,
        authenticationMethod: user.authenticationMethod,
        admin: user.admin,
        createdAt: user.createdAt,
        isNewUser,
      },
    });
  }
}

export const analytics = new BehaviouralAnalytics(env.POSTHOG_PROJECT_KEY);
