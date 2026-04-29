import { nanoid } from "nanoid";
import type { ErrorWebhook } from "@trigger.dev/core/v3/schemas";

export type ErrorAlertClassification = "new_issue" | "regression" | "unignored";

export type ErrorGroupAlertData = {
  classification: ErrorAlertClassification;
  error: {
    fingerprint: string;
    environmentId: string;
    environmentName: string;
    taskIdentifier: string;
    errorType: string;
    errorMessage: string;
    sampleStackTrace: string;
    firstSeen: string;
    lastSeen: string;
    occurrenceCount: number;
  };
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  project: {
    id: string;
    externalRef: string;
    slug: string;
    name: string;
  };
  dashboardUrl: string;
};

/**
 * Generates a webhook payload for an error group alert that conforms to the
 * ErrorWebhook schema from @trigger.dev/core/v3/schemas
 */
export function generateErrorGroupWebhookPayload(data: ErrorGroupAlertData): ErrorWebhook {
  return {
    id: nanoid(),
    created: new Date(),
    webhookVersion: "2025-01-01",
    type: "alert.error" as const,
    object: {
      classification: data.classification,
      error: {
        fingerprint: data.error.fingerprint,
        type: data.error.errorType,
        message: data.error.errorMessage,
        stackTrace: data.error.sampleStackTrace || undefined,
        firstSeen: new Date(Number(data.error.firstSeen)),
        lastSeen: new Date(Number(data.error.lastSeen)),
        occurrenceCount: data.error.occurrenceCount,
        taskIdentifier: data.error.taskIdentifier,
      },
      environment: {
        id: data.error.environmentId,
        name: data.error.environmentName,
      },
      organization: {
        id: data.organization.id,
        slug: data.organization.slug,
        name: data.organization.name,
      },
      project: {
        id: data.project.id,
        ref: data.project.externalRef,
        slug: data.project.slug,
        name: data.project.name,
      },
      dashboardUrl: data.dashboardUrl,
    },
  };
}
