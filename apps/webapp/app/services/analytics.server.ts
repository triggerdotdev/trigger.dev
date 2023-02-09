import { PostHog } from "posthog-node";
import { env } from "~/env.server";
import type { Organization } from "~/models/organization.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import type { User } from "~/models/user.server";
import type { Workflow } from "~/models/workflow.server";

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
      user,
      organization,
      organizationCount,
    }: {
      user: User;
      organization: Organization;
      organizationCount: number;
    }) => {
      //todo add org_count to user props
      if (this.client === undefined) return;
      this.#capture({
        userId: user.id,
        event: "organization created",
        organizationId: organization.id,
        userProperties: {
          organizationCount: organizationCount,
        },
      });
    },
  };

  workflow = {
    identify: ({ workflow }: { workflow: Workflow }) => {
      if (this.client === undefined) return;
      this.client.groupIdentify({
        groupType: "workflow",
        groupKey: workflow.id,
        properties: {
          name: workflow.title,
          slug: workflow.slug,
          packageJson: workflow.packageJson,
          jsonSchema: workflow.jsonSchema,
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
          organizationId: workflow.organizationId,
          type: workflow.type,
          status: workflow.status,
          externalSourceId: workflow.externalSourceId,
          service: workflow.service,
          eventNames: workflow.eventNames,
          disabledAt: workflow.disabledAt,
          archivedAt: workflow.archivedAt,
          isArchived: workflow.isArchived,
          triggerTtlInSeconds: workflow.triggerTtlInSeconds,
        },
      });
    },
  };

  environment = {
    identify: ({ environment }: { environment: RuntimeEnvironment }) => {
      if (this.client === undefined) return;
      this.client.groupIdentify({
        groupType: "environment",
        groupKey: environment.id,
        properties: {
          name: environment.slug,
          slug: environment.slug,
          organizationId: environment.organizationId,
          createdAt: environment.createdAt,
          updatedAt: environment.updatedAt,
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

    if (event.workflowId) {
      groups = {
        ...groups,
        workflow: event.workflowId,
      };
    }

    let properties: Record<string, any> = {};
    if (event.eventProperties) {
      properties = {
        ...properties,
        ...event.userProperties,
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

    this.client.capture({
      distinctId: event.userId,
      event: event.event,
      properties,
      groups,
    });
  }
}

type CaptureEvent = {
  userId: string;
  event: string;
  organizationId?: string;
  workflowId?: string;
  eventProperties?: Record<string, any>;
  userProperties?: Record<string, any>;
  userOnceProperties?: Record<string, any>;
};

export const analytics = new BehaviouralAnalytics(env.POSTHOG_PROJECT_KEY);
