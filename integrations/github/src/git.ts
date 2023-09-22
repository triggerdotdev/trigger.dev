import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { GitHubReturnType, GitHubRunTask, onError } from "./index";
import { repoProperties } from "./propertyHelpers";

type Endcoding = "utf-8" | "base-64";

type AuthorContent = {
  name: string;
  email: string;
  date?: string;
};

type CommitterContent = {
  name?: string;
  email?: string;
  date?: string;
};

type TagType = "commit" | "tree" | "blob";

type TaggerContent = {
  name: string;
  email: string;
  date?: string;
};

type TreeType = {
  path?: string | undefined;
  mode?: "100644" | "100755" | "040000" | "160000" | "120000" | undefined;
  type?: "commit" | "tree" | "blob" | undefined;
  sha?: string | null | undefined;
  content?: string | undefined;
};

export class Git {
  constructor(private runTask: GitHubRunTask) {}

  createBlob(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      content: string;
      encoding?: Endcoding;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["createBlob"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.createBlob({
          owner: params.owner,
          repo: params.repo,
          content: params.content,
          encoding: params.encoding,
        });
        return result.data;
      },
      {
        name: "Create Blob",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Content",
            text: params.content,
          },
        ],
      },
      onError
    );
  }

  getBlob(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      fileSHA: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["getBlob"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.getBlob({
          owner: params.owner,
          repo: params.repo,
          file_sha: params.fileSHA,
        });
        return result.data;
      },
      {
        name: "Get Blob",
        params,
        properties: [...repoProperties(params)],
      },
      onError
    );
  }

  createCommit(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      message: string;
      tree: string;
      parents?: string[];
      author?: AuthorContent;
      committer?: CommitterContent;
      signature?: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["createCommit"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.createCommit({
          ...params,
        });
        return result.data;
      },
      {
        name: "Create Commit",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Message",
            text: params.message,
          },
          {
            label: "Tree",
            text: params.tree,
          },
        ],
      },
      onError
    );
  }

  getCommit(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      commitSHA: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["getCommit"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.getCommit({
          owner: params.owner,
          repo: params.repo,
          commit_sha: params.commitSHA,
        });
        return result.data;
      },
      {
        name: "Get Commit",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Commit SHA",
            text: params.commitSHA,
          },
        ],
      },
      onError
    );
  }

  listMatchingRefs(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      ref: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["listMatchingRefs"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.listMatchingRefs(params);
        return result.data;
      },
      {
        name: "List Matching References",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Ref",
            text: params.ref,
          },
        ],
      },
      onError
    );
  }

  getRef(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      ref: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["getRef"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.getRef(params);
        return result.data;
      },
      {
        name: "Get Reference",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Ref",
            text: params.ref,
          },
        ],
      },
      onError
    );
  }

  createRef(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      ref: string;
      sha: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["createRef"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.createRef(params);
        return result.data;
      },
      {
        name: "Create Reference",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Ref",
            text: params.ref,
          },
          {
            label: "SHA",
            text: params.ref,
          },
        ],
      },
      onError
    );
  }

  updateRef(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      ref: string;
      sha: string;
      force?: boolean;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["updateRef"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.updateRef(params);
        return result.data;
      },
      {
        name: "Update Reference",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Ref",
            text: params.ref,
          },
          {
            label: "SHA",
            text: params.ref,
          },
        ],
      },
      onError
    );
  }

  deleteRef(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      ref: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["deleteRef"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.deleteRef(params);
        return result.data;
      },
      {
        name: "Delete Reference",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Ref",
            text: params.ref,
          },
        ],
      },
      onError
    );
  }

  createTag(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      tag: string;
      message: string;
      object: string;
      type: TagType;
      tagger?: TaggerContent;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["createTag"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.createTag(params);
        return result.data;
      },
      {
        name: "Create Tag",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Tag",
            text: params.tag,
          },
          {
            label: "Message",
            text: params.message,
          },
          {
            label: "Object",
            text: params.object,
          },
          {
            label: "Tag Type",
            text: params.type,
          },
        ],
      },
      onError
    );
  }

  getTag(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      tagSHA: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["getTag"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.getTag({
          owner: params.owner,
          repo: params.repo,
          tag_sha: params.tagSHA,
        });
        return result.data;
      },
      {
        name: "Get Tag",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Tag SHA",
            text: params.tagSHA,
          },
        ],
      },
      onError
    );
  }

  createTree(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      tree: TreeType[];
      baseTree?: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["createTree"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.createTree(params);
        return result.data;
      },
      {
        name: "Create Tree",
        params,
        properties: [...repoProperties(params)],
      },
      onError
    );
  }

  getTree(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      treeSHA: string;
      recursive?: string;
    }
  ): GitHubReturnType<Octokit["rest"]["git"]["getTree"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.git.getTree({
          owner: params.owner,
          repo: params.repo,
          tree_sha: params.treeSHA,
          recursive: params.recursive,
        });
        return result.data;
      },
      {
        name: "Get Tree",
        params,
        properties: [
          ...repoProperties(params),
          {
            label: "Tree SHA",
            text: params.treeSHA,
          },
        ],
      },
      onError
    );
  }
}
