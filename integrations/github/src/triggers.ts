import { IssuesOpenedEvent } from "@octokit/webhooks-types";
import { ExternalSourceEventTrigger, Trigger } from "@trigger.dev/sdk";
import { repositoryWebhookSource } from "./sources";

export function onIssueOpened(params: {
  repo: string;
}): Trigger<IssuesOpenedEvent> {
  return new ExternalSourceEventTrigger<IssuesOpenedEvent>({
    title: "On Issue Opened",
    elements: [
      {
        label: "Repo",
        text: params.repo,
      },
    ],
    source: repositoryWebhookSource({ repo: params.repo, events: ["issues"] }),
  });
}

// export const onIssueOpened = createEvent(connection, {
//   trigger: (params: { repo: string }): Trigger<IssuesOpenedEvent> =>
//     new HttpEventTrigger<IssuesOpenedEvent>({
//       title: "On Issue Opened",
//       name: "issues",
//       source: metadata.id,
//       key: `repo.${params.repo}.issues`,
//       connection: metadata,
//       register: async (client, auth) => {},
//     }),
//   register: async (client, params) => {},
// });
