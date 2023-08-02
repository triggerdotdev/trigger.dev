import { PostHog } from "posthog-node";
import { env } from "~/env.server";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";
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

  user = {
    identify: ({ user, isNewUser }: { user: User; isNewUser: boolean }) => {
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
      }
    },
  };

  organization = {
    identify: ({ organization }: { organization: Organization }) => {
      if (this.client === undefined) return;
      this.client.groupIdentify({
        groupType: "organization",
        groupKey: organization.id,
        properties: {
          name: organization.title,
          slug: organization.slug,
          createdAt: organization.createdAt,
          updatedAt: organization.updatedAt,
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
      if (this.client === undefined) return;
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
    identify: ({ project }: { project: Project }) => {
      if (this.client === undefined) return;
      this.client.groupIdentify({
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
      if (this.client === undefined) return;
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
    if (this.client === undefined) return;
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
    this.client.capture(eventData);
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

export const analytics = new BehaviouralAnalytics(env.POSTHOG_PROJECT_KEY);
