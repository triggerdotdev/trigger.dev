import type { TriggerEvent } from "@trigger.dev/sdk";
import * as schemas from "./schemas";

export function commitCommentEvent(params: {
  repo: string;
}): TriggerEvent<typeof schemas.commitComments.commitCommentEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "commit_comment",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
        },
        event: ["commit_comment"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["commit_comment"],
      }),
      manualRegistration: false,
    },
    schema: schemas.commitComments.commitCommentEventSchema,
  };
}

export function issueEvent(params: {
  repo: string;
}): TriggerEvent<typeof schemas.issues.issuesEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "issues",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
        },
        event: ["issues"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["issues"],
      }),
      manualRegistration: false,
    },
    schema: schemas.issues.issuesEventSchema,
  };
}

export function issueCommentEvent(params: {
  repo: string;
}): TriggerEvent<typeof schemas.issuesComments.issueCommentEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "issue_comment",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
        },
        event: ["issue_comment"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["issue_comment"],
      }),
      manualRegistration: false,
    },
    schema: schemas.issuesComments.issueCommentEventSchema,
  };
}

export function pullRequestEvent(params: {
  repo: string;
}): TriggerEvent<typeof schemas.pullRequest.pullRequestEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "pull_request",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
        },
        event: ["pull_request"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["pull_request"],
      }),
      manualRegistration: false,
    },
    schema: schemas.pullRequest.pullRequestEventSchema,
  };
}

export function pullRequestCommentEvent(params: {
  repo: string;
}): TriggerEvent<
  typeof schemas.pullRequestComments.pullRequestReviewCommentEventSchema
> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "pull_request_review_comment",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
        },
        event: ["pull_request_review_comment"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["pull_request_review_comment"],
      }),
      manualRegistration: false,
    },
    schema: schemas.pullRequestComments.pullRequestReviewCommentEventSchema,
  };
}

export function pullRequestReviewEvent(params: {
  repo: string;
}): TriggerEvent<
  typeof schemas.pullRequestReviews.pullRequestReviewEventSchema
> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "pull_request_review",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
        },
        event: ["pull_request_review"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["pull_request_review"],
      }),
      manualRegistration: false,
    },
    schema: schemas.pullRequestReviews.pullRequestReviewEventSchema,
  };
}

export function pushEvent(params: {
  repo: string;
}): TriggerEvent<typeof schemas.push.pushEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "push",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
        },
        event: ["push"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["push"],
      }),
      manualRegistration: false,
    },
    schema: schemas.push.pushEventSchema,
  };
}

export function newStarEvent(params: {
  repo: string;
}): TriggerEvent<typeof schemas.stars.starCreatedEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "star",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
          action: ["created"],
        },
        event: ["star"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["star"],
      }),
      manualRegistration: false,
    },
    schema: schemas.stars.starCreatedEventSchema,
  };
}
