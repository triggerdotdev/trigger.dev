import { truncate } from "@trigger.dev/integration-kit";
import { IntegrationTaskKey, Prettify, retry } from "@trigger.dev/sdk";
import { GitHubReturnType, GitHubRunTask, onError } from "./index";
import { Octokit } from "octokit";
import { issueProperties, repoProperties } from "./propertyHelpers";

export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export class Reactions {
  constructor(private runTask: GitHubRunTask) {}

  createForIssueComment(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      commentId: number;
      content: ReactionContent;
    }
  ): GitHubReturnType<Octokit["rest"]["reactions"]["createForIssueComment"]> {
    let emoji = "";

    switch (params.content) {
      case "+1":
        emoji = "👍";
        break;
      case "-1":
        emoji = "👎";
        break;
      case "laugh":
        emoji = "😄";
        break;
      case "confused":
        emoji = "😕";
        break;
      case "heart":
        emoji = "❤️";
        break;
      case "hooray":
        emoji = "🎉";
        break;
      case "rocket":
        emoji = "🚀";
        break;
      case "eyes":
        emoji = "👀";
        break;
    }

    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.reactions.createForIssueComment({
          owner: params.owner,
          repo: params.repo,
          comment_id: params.commentId,
          content: params.content,
        });
        return result.data;
      },
      {
        name: "Add Issue Reaction",
        params,
        properties: [
          {
            label: "Repo",
            text: params.repo,
          },
          {
            label: "Comment",
            text: `#${params.commentId}`,
          },
          { label: "reaction", text: emoji },
        ],
      },
      onError
    );
  }
}
