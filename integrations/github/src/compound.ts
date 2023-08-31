import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { GitHubReturnType, GitHubRunTask, onError } from "./index";
import { Issues } from "./issues";
import { ReactionContent, Reactions } from "./reactions";

export class Compound {
  runTask: GitHubRunTask;

  constructor(runTask: GitHubRunTask) {
    this.runTask = runTask;
  }

  createForIssueComment(
    key: IntegrationTaskKey,
    params: {
      body: string;
      owner: string;
      repo: string;
      issueNumber: number;
      reaction: ReactionContent;
    }
  ): GitHubReturnType<Octokit["rest"]["issues"]["createComment"]> {
    const issue = new Issues(this.runTask.bind(this));
    const reactions = new Reactions(this.runTask.bind(this));

    return this.runTask(
      key,
      async () => {
        const comment = await issue.createComment(
          `Comment on Issue #${params.issueNumber}`,
          params
        );
        const reaction = await reactions.createForIssueComment(`React with ${params.reaction}`, {
          owner: params.owner,
          repo: params.repo,
          commentId: comment.id,
          content: params.reaction,
        });
        return comment;
      },
      {
        name: "Create Issue Comment",
        params,
        properties: [
          {
            label: "Repo",
            text: params.repo,
          },
          {
            label: "Issue",
            text: `#${params.issueNumber}`,
          },
        ],
      },
      onError
    );
  }
}
