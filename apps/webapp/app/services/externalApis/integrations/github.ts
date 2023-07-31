import type { HelpSample, Integration, ScopeAnnotation } from "../types";

const repoAnnotation: ScopeAnnotation = {
  label: "Repo",
};

const webhookAnnotation: ScopeAnnotation = {
  label: "Webhooks",
};

const orgAnnotation: ScopeAnnotation = {
  label: "Orgs",
};

const keysAnnotation: ScopeAnnotation = {
  label: "Keys",
};

const userAnnotation: ScopeAnnotation = {
  label: "User",
};

const usageSample: HelpSample = {
  title: "Using the client",
  code: `
  import { Github, events } from "@trigger.dev/github";

  const github = new Github({
    id: "__SLUG__",
    token: process.env.GITHUB_TOKEN,
  });
  
  client.defineJob({
    id: "alert-on-new-github-issues",
    name: "Alert on new GitHub issues",
    version: "0.1.1",
    trigger: github.triggers.repo({
      event: events.onIssueOpened,
      owner: "triggerdotdev",
      repo: "trigger.dev",
    }),
    run: async (payload, io, ctx) => {
      //wrap the SDK call in runTask
      const { data } = await io.runTask(
        "create-card",
        { name: "Create card" },
        async () => {
          //create a project card using the underlying client
          return io.github.client.rest.projects.createCard({
            column_id: 123,
            note: "test",
          });
        }
      );
  
      //log the url of the created card
      await io.logger.info(data.url);
    },
  });
  
  `,
};

export const github: Integration = {
  identifier: "github",
  name: "GitHub",
  packageName: "@trigger.dev/github@latest",
  authenticationMethods: {
    oauth2: {
      name: "OAuth",
      type: "oauth2",
      client: {
        id: {
          envName: "CLOUD_GITHUB_CLIENT_ID",
        },
        secret: {
          envName: "CLOUD_GITHUB_CLIENT_SECRET",
        },
      },
      config: {
        authorization: {
          url: "https://github.com/login/oauth/authorize",
          scopeSeparator: " ",
        },
        token: {
          url: "https://github.com/login/oauth/access_token",
          metadata: {
            accountPointer: "/team/name",
          },
        },
        refresh: {
          url: "https://github.com/login/oauth/authorize",
        },
      },
      scopes: [
        {
          name: "repo",
          description:
            "Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks. Note: In addition to repository related resources, the repo scope also grants access to manage organization-owned resources including projects, invitations, team memberships and webhooks. This scope also grants the ability to manage projects owned by users.",
          annotations: [repoAnnotation],
        },

        {
          name: "repo:status",
          description:
            "Grants read/write access to commit statuses in public and private repositories. This scope is only necessary to grant other users or services access to private repository commit statuses without granting access to the code.",
          annotations: [repoAnnotation],
        },

        {
          name: "repo_deployment",
          description:
            "Grants access to deployment statuses for public and private repositories. This scope is only necessary to grant other users or services access to deployment statuses, without granting access to the code.",
          annotations: [repoAnnotation],
        },

        {
          name: "public_repo",
          description:
            "Limits access to public repositories. That includes read/write access to code, commit statuses, repository projects, collaborators, and deployment statuses for public repositories and organizations. Also required for starring public repositories.",
          annotations: [repoAnnotation],
        },

        {
          name: "repo:invite",
          description:
            "Grants accept/decline abilities for invitations to collaborate on a repository. This scope is only necessary to grant other users or services access to invites without granting access to the code.",
          annotations: [repoAnnotation],
        },

        {
          name: "delete_repo",
          description: "Grants access to delete adminable repositories.",
          annotations: [repoAnnotation],
        },

        {
          name: "security_events",
          description:
            "Grants read and write access to security events in the code scanning API. This scope is only necessary to grant other users or services access to security events without granting access to the code.",
        },

        {
          name: "admin:repo_hook",
          description:
            "Grants read, write, ping, and delete access to repository hooks in public or private repositories. The repo and public_repo scopes grant full access to repositories, including repository hooks. Use the admin:repo_hook scope to limit access to only repository hooks.",
          defaultChecked: true,
          annotations: [webhookAnnotation],
        },
        {
          name: "write:repo_hook",
          description:
            "Grants read, write, and ping access to hooks in public or private repositories.",
          annotations: [webhookAnnotation],
        },
        {
          name: "read:repo_hook",
          description:
            "Grants read and ping access to hooks in public or private repositories.",
          annotations: [webhookAnnotation],
        },

        {
          name: "admin:org",
          description:
            "Fully manage the organization and its teams, projects, and memberships.",
          annotations: [orgAnnotation],
        },
        {
          name: "write:org",
          description:
            "Read and write access to organization membership, organization projects, and team membership.",
          annotations: [orgAnnotation],
        },

        {
          name: "read:org",
          description:
            "Read-only access to organization membership, organization projects, and team membership.",
          annotations: [orgAnnotation],
        },

        {
          name: "admin:public_key",
          description: "Fully manage public keys.",
          annotations: [keysAnnotation],
        },

        {
          name: "write:public_key",
          description: "Create, list, and view details for public keys.",
          annotations: [keysAnnotation],
        },
        {
          name: "read:public_key",
          description: "List and view details for public keys.",
          annotations: [keysAnnotation],
        },

        {
          name: "admin:org_hook",
          description:
            "Grants read, write, ping, and delete access to organization hooks. Note: OAuth tokens will only be able to perform these actions on organization hooks which were created by the OAuth App. Personal access tokens will only be able to perform these actions on organization hooks created by a user.",
          annotations: [orgAnnotation, webhookAnnotation],
        },

        {
          name: "gist",
          description: "Grants write access to gists.",
        },
        {
          name: "notifications",
          description:
            "Grants read access to a user's notifications, mark as read access to threads, watch and unwatch access to a repository, and read, write, and delete access to thread subscriptions.",
        },
        {
          name: "user",
          description:
            "	Grants read/write access to profile info only. Note that this scope includes user:email and user:follow.",
          annotations: [userAnnotation],
        },
        {
          name: "read:user",
          description: "Grants read access to a user's profile data.",
          annotations: [userAnnotation],
        },

        {
          name: "user:email",
          description: "Grants read access to a user's email addresses.",
          annotations: [userAnnotation],
        },
        {
          name: "user:follow",
          description: "Grants access to follow or unfollow other users.",
          annotations: [userAnnotation],
        },
        {
          name: "project",
          description:
            "Grants read/write access to user and organization projects.",
        },

        {
          name: "read:project",
          description:
            "Grants read only access to user and organization projects.",
        },

        {
          name: "write:discussion",
          description: "Allows read and write access for team discussions.",
        },

        {
          name: "read:discussion",
          description: "Allows read access for team discussions.",
        },

        {
          name: "write:packages",
          description:
            "Grants access to upload or publish a package in GitHub Packages.",
        },

        {
          name: "read:packages",
          description:
            "Grants access to download or install packages from GitHub Packages.",
        },

        {
          name: "delete:packages",
          description: "Grants access to delete packages from GitHub Packages.",
        },

        {
          name: "admin:gpg_key",
          description: "Fully manage GPG keys.",
        },

        {
          name: "write:gpg_key",
          description: "Create, list, and view details for GPG keys.",
        },

        {
          name: "read:gpg_key",
          description: "List and view details for GPG keys.",
        },

        {
          name: "codespace",
          description:
            "Grants the ability to create and manage codespaces. Codespaces can expose a GITHUB_TOKEN which may have a different set of scopes",
        },

        {
          name: "workflow",
          description:
            "Grants the ability to add and update GitHub Actions workflow files. Workflow files can be committed without this scope if the same file (with both the same path and contents) exists on another branch in the same repository. Workflow files can expose GITHUB_TOKEN which may have a different set of scopes.",
        },
      ],
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Github } from "@trigger.dev/github";

const github = new Github({
  id: "__SLUG__"
});
`,
          },
          usageSample,
        ],
      },
    },
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Github } from "@trigger.dev/github";

const github = new Github({
  id: "__SLUG__",
  token: process.env.GITHUB_TOKEN
});
`,
          },
          usageSample,
        ],
      },
    },
  },
};
