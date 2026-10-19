import { PostHog } from "posthog-node";
import { z } from "zod";
import { env } from "~/env.server";
import type { MatchedOrganization } from "~/hooks/useOrganizations";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";
import type { User } from "~/models/user.server";
import { extractDomain } from "~/utils/favicon";
import { featuresForUrl } from "~/features.server";
import { singleton } from "~/utils/singleton";
import { enqueueAttioUserSync } from "./attio.server";
import { loopsClient } from "./loops.server";

const OrgOnboardingDataSchema = z.object({ companyUrl: z.string().optional() });

// Cloud-only telemetry. Self-hosted installs must keep sending exactly what
// they did before, so new events are gated on this rather than expanding what
// self-hosters emit. Derived from APP_ORIGIN so it works without a request.
const IS_MANAGED_CLOUD = (() => {
  try {
    return featuresForUrl(new URL(env.APP_ORIGIN)).isManagedCloud;
  } catch {
    return false;
  }
})();

type Options = {
  postHogApiKey?: string;
};

class Telemetry {
  #posthogClient: PostHog | undefined = undefined;

  constructor({ postHogApiKey }: Options) {
    if (env.TRIGGER_TELEMETRY_DISABLED !== undefined) {
      console.log("📉 Telemetry disabled");
      return;
    }

    if (postHogApiKey) {
      this.#posthogClient = new PostHog(postHogApiKey, { host: env.POSTHOG_HOST });
    } else {
      console.log("No PostHog API key, so analytics won't track");
    }
  }

  user = {
    identify: ({
      user,
      isNewUser,
      referralSource,
    }: {
      user: User;
      isNewUser: boolean;
      referralSource?: string;
    }) => {
      if (this.#posthogClient) {
        const properties: Record<string, any> = {
          email: user.email,
          name: user.name,
          authenticationMethod: user.authenticationMethod,
          admin: user.admin,
          createdAt: user.createdAt,
          isNewUser,
        };

        if (referralSource) {
          properties.referralSource = referralSource;
        }

        this.#posthogClient.identify({
          distinctId: user.id,
          properties,
        });
      }
      if (isNewUser) {
        this.#capture({
          userId: user.id,
          event: "user created",
          eventProperties: {
            email: user.email,
            name: user.name,
            authenticationMethod: user.authenticationMethod,
            admin: user.admin,
            createdAt: user.createdAt,
          },
        });

        loopsClient?.userCreated({
          userId: user.id,
          email: user.email,
          name: user.name,
        });

        enqueueAttioUserSync({
          userId: user.id,
          email: user.email,
          referralSource: referralSource ?? user.referralSource,
          marketingEmails: user.marketingEmails,
          createdAt: user.createdAt,
        });
      }
    },
    onboardingDetailsSubmitted: ({
      userId,
      referralSource,
      referralSourceOther,
      role,
    }: {
      userId: string;
      referralSource?: string;
      referralSourceOther?: string;
      role?: string;
    }) => {
      if (this.#posthogClient === undefined) return;
      if (!IS_MANAGED_CLOUD) return;

      const properties: Record<string, any> = {};
      if (referralSource) {
        properties.referral_source_self_reported = referralSource;
      }
      if (referralSource === "Other" && referralSourceOther) {
        properties.referral_source_other = referralSourceOther;
      }
      if (role) {
        properties.role = role;
      }
      this.#capture({
        userId,
        event: "onboarding details submitted",
        eventProperties: properties,
        userProperties: properties,
      });
    },
  };

  organization = {
    identify: ({ organization }: { organization: MatchedOrganization }) => {
      if (this.#posthogClient === undefined) return;
      this.#posthogClient.groupIdentify({
        groupType: "organization",
        groupKey: organization.id,
        properties: {
          name: organization.title,
          slug: organization.slug,
        },
      });
    },
    new: ({ userId, organization }: { userId: string; organization: Organization }) => {
      if (this.#posthogClient === undefined) return;
      if (!IS_MANAGED_CLOUD) return;

      const companyProperties: Record<string, string> = {};
      const onboardingData = OrgOnboardingDataSchema.safeParse(organization.onboardingData);
      const companyDomain =
        onboardingData.success && onboardingData.data.companyUrl
          ? extractDomain(onboardingData.data.companyUrl)
          : null;
      if (companyDomain) {
        companyProperties.company_domain = companyDomain;
      }
      if (organization.companySize) {
        companyProperties.company_size = organization.companySize;
      }

      this.#posthogClient.groupIdentify({
        groupType: "organization",
        groupKey: organization.id,
        properties: {
          name: organization.title,
          slug: organization.slug,
          ...companyProperties,
        },
      });

      this.#capture({
        userId,
        event: "organization created",
        organizationId: organization.id,
        eventProperties: {
          id: organization.id,
          slug: organization.slug,
          title: organization.title,
          createdAt: organization.createdAt,
          updatedAt: organization.updatedAt,
          ...companyProperties,
        },
      });
    },
  };

  project = {
    identify: ({
      project,
    }: {
      project: Pick<Project, "id" | "name" | "createdAt" | "updatedAt">;
    }) => {
      if (this.#posthogClient === undefined) return;
      this.#posthogClient.groupIdentify({
        groupType: "project",
        groupKey: project.id,
        properties: {
          name: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      });
    },
    new: ({
      userId,
      organizationId,
      project,
    }: {
      userId: string;
      organizationId: string;
      project: Project;
    }) => {
      if (this.#posthogClient === undefined) return;
      if (!IS_MANAGED_CLOUD) return;
      this.#capture({
        userId,
        event: "project created",
        organizationId,
        projectId: project.id,
        eventProperties: {
          id: project.id,

          title: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      });
    },
  };

  dashboardAgent = {
    /** Returns whether the report was captured, so the agent never claims one that was dropped. */
    feedback: ({
      userId,
      organizationId,
      projectId,
      environmentId,
      chatId,
      message,
      toolName,
    }: {
      userId: string;
      organizationId: string;
      projectId: string;
      environmentId: string;
      chatId: string;
      message: string;
      toolName?: string;
    }): boolean => {
      if (this.#posthogClient === undefined) return false;
      if (!IS_MANAGED_CLOUD) return false;
      this.#capture({
        userId,
        event: "dashboard_agent_feedback_submitted",
        organizationId,
        projectId,
        environmentId,
        eventProperties: { chatId, message, toolName },
      });
      return true;
    },
  };

  webhooks = {
    /**
     * Same event the marketing site's beta form sends, so requests from both land in one
     * PostHog insight broken down by `orgSlug`.
     */
    betaRequested: ({
      user,
      organization,
    }: {
      user: { id: string; email: string };
      organization: { id: string; slug: string; title: string };
    }) => {
      if (this.#posthogClient === undefined) return;
      if (!IS_MANAGED_CLOUD) return;
      this.#capture({
        userId: user.id,
        event: "webhooks_beta_requested",
        organizationId: organization.id,
        eventProperties: {
          source: "dashboard",
          email: user.email,
          orgId: organization.id,
          orgSlug: organization.slug,
          orgTitle: organization.title,
        },
      });
    },
  };

  #capture(event: CaptureEvent) {
    if (this.#posthogClient === undefined) return;
    let groups: Record<string, string> = {};

    if (event.organizationId) {
      groups = {
        ...groups,
        organization: event.organizationId,
      };
    }

    if (event.projectId) {
      groups = {
        ...groups,
        project: event.projectId,
      };
    }

    if (event.jobId) {
      groups = {
        ...groups,
        workflow: event.jobId,
      };
    }

    if (event.environmentId) {
      groups = {
        ...groups,
        environment: event.environmentId,
      };
    }

    let properties: Record<string, any> = {};
    if (event.eventProperties) {
      properties = {
        ...properties,
        ...event.eventProperties,
      };
    }

    if (event.userProperties) {
      properties = {
        ...properties,
        $set: event.userProperties,
      };
    }

    if (event.userOnceProperties) {
      properties = {
        ...properties,
        $set_once: event.userOnceProperties,
      };
    }

    const eventData = {
      distinctId: event.userId,
      event: event.event,
      properties,
      groups,
    };
    this.#posthogClient.capture(eventData);
  }
}

type CaptureEvent = {
  userId: string;
  event: string;
  organizationId?: string;
  projectId?: string;
  jobId?: string;
  environmentId?: string;
  eventProperties?: Record<string, any>;
  userProperties?: Record<string, any>;
  userOnceProperties?: Record<string, any>;
};

export const telemetry = singleton(
  "telemetry",
  () =>
    new Telemetry({
      postHogApiKey: env.POSTHOG_PROJECT_KEY,
    })
);
