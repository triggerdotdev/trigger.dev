import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { GitHubReturnType, GitHubRunTask, onError } from "./index";
import { Issues } from "./issues";
import { ReactionContent, Reactions } from "./reactions";

export class Compound {
  constructor(
    private runTask: GitHubRunTask,
    public issues: Issues,
    public reactions: Reactions
  ) {}

  createIssueCommentWithReaction(
    key: IntegrationTaskKey,
    params: {
      body: string;
      owner: string;
      repo: string;
      issueNumber: number;
      reaction: ReactionContent;
    }
  ): GitHubReturnType<Octokit["rest"]["issues"]["createComment"]> {
    return this.runTask(
      key,
      async () => {
        const comment = await this.issues.createComment(
          `Comment on Issue #${params.issueNumber}`,
          params
        );
        const reaction = await this.reactions.createForIssueComment(
          `React with ${params.reaction}`,
          {
            owner: params.owner,
            repo: params.repo,
            commentId: comment.id,
            content: params.reaction,
          }
        );
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
