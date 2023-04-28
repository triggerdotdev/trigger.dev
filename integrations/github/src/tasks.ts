import { authenticatedTask } from "@trigger.dev/sdk";
import { Octokit } from "octokit";

export const createIssue = authenticatedTask({
  run: async (
    params: { title: string; repo: string },
    client: InstanceType<typeof Octokit>,
    task
  ) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.issues
      .create({
        owner,
        repo,
        title: params.title,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Create Issue",
      params,
      elements: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Title",
          text: params.title,
        },
      ],
    };
  },
});

export const createIssueComment = authenticatedTask({
  run: async (
    params: { body: string; repo: string; issueNumber: number },
    client: InstanceType<typeof Octokit>,
    task
  ) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.issues
      .createComment({
        owner,
        repo,
        body: params.body,
        issue_number: params.issueNumber,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Create Issue Comment",
      params,
      elements: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Issue",
          text: `#${params.issueNumber}`,
        },
      ],
    };
  },
});

export const getRepo = authenticatedTask({
  run: async (
    params: { repo: string },
    client: InstanceType<typeof Octokit>,
    task
  ) => {
    const [owner, repo] = params.repo.split("/");

    const response = await client.rest.repos.get({
      owner,
      repo,
    });

    return response.data;
  },
  init: (params) => {
    return {
      name: "Get Repo",
      params,
      elements: [
        {
          label: "Repo",
          text: params.repo,
        },
      ],
    };
  },
});

type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export const addIssueCommentReaction = authenticatedTask({
  run: async (
    params: {
      repo: string;
      commentId: number;
      content: ReactionContent;
    },
    client: InstanceType<typeof Octokit>,
    task
  ) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.reactions
      .createForIssueComment({
        owner,
        repo,
        comment_id: params.commentId,
        content: params.content,
      })
      .then((res) => res.data);
  },
  init: (params) => {
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

    return {
      name: "Add Issue Reaction",
      params,
      elements: [
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
    };
  },
});

export const createIssueCommentWithReaction = authenticatedTask({
  run: async (
    params: {
      body: string;
      repo: string;
      issueNumber: number;
      reaction: ReactionContent;
    },
    client: InstanceType<typeof Octokit>,
    task,
    io
  ) => {
    const comment = await io.runTask(
      `Comment on Issue #${params.issueNumber}`,
      createIssueComment.init(params),
      async (t) => {
        return createIssueComment.run(params, client, t, io);
      }
    );

    await io.runTask(
      `React with ${params.reaction}`,
      addIssueCommentReaction.init({
        repo: params.repo,
        commentId: comment.id,
        content: params.reaction,
      }),
      async (t) => {
        return addIssueCommentReaction.run(
          {
            repo: params.repo,
            commentId: comment.id,
            content: params.reaction,
          },
          client,
          t,
          io
        );
      }
    );

    return comment;
  },
  init: (params) => {
    return {
      name: "Create Issue Comment",
      params,
      elements: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Issue",
          text: `#${params.issueNumber}`,
        },
      ],
    };
  },
});
