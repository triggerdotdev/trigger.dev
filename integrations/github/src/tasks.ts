import { authenticatedTask } from "@trigger.dev/sdk";
import { clientFactory } from "./client";

export const createIssue = authenticatedTask({
  clientFactory,
  run: async (params: { title: string; repo: string }, client, task) => {
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
  clientFactory,
  run: async (
    params: { body: string; repo: string; issueNumber: number },
    client,
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
  clientFactory,
  run: async (params: { repo: string }, client, task) => {
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
