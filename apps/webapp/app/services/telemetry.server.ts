import { PostHog } from "posthog-node";
import { env } from "~/env.server";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";
import type { User } from "~/models/user.server";
import { singleton } from "~/utils/singleton";
import { loopsClient } from "./loops.server";

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
      this.#posthogClient = new PostHog(postHogApiKey, { host: "https://eu.posthog.com" });
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
      }
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
    new: ({
      userId,
      organization,
      organizationCount,
    }: {
      userId: string;
      organization: Organization;
      organizationCount: number;
    }) => {
      if (this.#posthogClient === undefined) return;
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
        },
        userProperties: {
          organizationCount: organizationCount,
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
      this.#capture({
        userId,
        event: "project created",
        organizationId,
        eventProperties: {
          id: project.id,

          title: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
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
