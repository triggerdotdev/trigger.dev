import { truncate } from "@trigger.dev/integration-kit";
import { IntegrationTaskKey, Prettify, retry } from "@trigger.dev/sdk";
import { GitHubReturnType, GitHubRunTask, onError } from "./index";
import { Octokit } from "octokit";
import { issueProperties, repoProperties } from "./propertyHelpers";

type AddIssueLabels = GitHubReturnType<Octokit["rest"]["issues"]["addLabels"]>;
export class Issues {
  constructor(private runTask: GitHubRunTask) {}

  create(
    key: IntegrationTaskKey,
    params: { title: string; owner: string; repo: string }
  ): GitHubReturnType<Octokit["rest"]["issues"]["create"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.issues.create({
          owner: params.owner,
          repo: params.repo,
          title: params.title,
        });
        return result.data;
      },
      {
        name: "Create Issue",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Title",
            text: params.title,
          },
        ],
      },
      onError
    );
  }

  addAssignees(
    key: IntegrationTaskKey,
    params: { owner: string; repo: string; issueNumber: number; assignees: string[] }
  ): GitHubReturnType<Octokit["rest"]["issues"]["addAssignees"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.issues.addAssignees({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.issueNumber,
          assignees: params.assignees,
        });
        return result.data;
      },
      {
        name: "Add Issue Assignees",
        params,
        properties: [
          ...repoProperties(params),
          ...issueProperties(params),
          {
            label: "assignees",
            text: params.assignees.join(", "),
          },
        ],
      },
      onError
    );
  }

  addLabels(
    key: IntegrationTaskKey,
    params: { owner: string; repo: string; issueNumber: number; labels: string[] }
  ): AddIssueLabels {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.issues.addLabels({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.issueNumber,
          labels: params.labels,
        });
        return result.data;
      },
      {
        name: "Add Issue Labels",
        params,
        properties: [
          ...repoProperties(params),
          ...issueProperties(params),
          {
            label: "Labels",
            text: params.labels.join(", "),
          },
        ],
      },
      onError
    );
  }

  createComment(
    key: IntegrationTaskKey,
    params: { body: string; owner: string; repo: string; issueNumber: number }
  ): GitHubReturnType<Octokit["rest"]["issues"]["createComment"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.issues.createComment({
          owner: params.owner,
          repo: params.repo,
          body: params.body,
          issue_number: params.issueNumber,
        });
        return result.data;
      },
      {
        name: "Create Issue Comment",
        params,
        properties: [...repoProperties(params), ...issueProperties(params)],
      },
      onError
    );
  }

  get(
    key: IntegrationTaskKey,
    params: { owner: string; repo: string; issueNumber: number }
  ): GitHubReturnType<Octokit["rest"]["issues"]["get"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.issues.get({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.issueNumber,
        });
        return result.data;
      },
      {
        name: "Get Issue",
        params,
        properties: [...repoProperties(params), ...issueProperties(params)],
      },
      onError
    );
  }
}
