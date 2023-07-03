import type { Help, Integration } from "../types";

const help: Help = {
  samples: [
    {
      title: "Creating the client",
      code: `
import { Slack } from "@trigger.dev/slack";

const slack = new Slack({
  id: "__SLUG__",
});
`,
    },
    {
      title: "Using the client",
      code: `
new Job(client, {
  id: "slack-test",
  name: "Slack test",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "slack.test",
    schema: z.object({}),
  }),
  integrations: {
    slack,
  },
  run: async (payload, io, ctx) => {
    const response = await io.slack.postMessage("post message", {
      channel: "C04GWUTDC3W",
      text: "My first Slack message",
    });
  },
});
      `,
      highlight: [
        [9, 11],
        [13, 16],
      ],
    },
  ],
};

export const slack: Integration = {
  identifier: "slack",
  name: "Slack",
  packageName: "@trigger.dev/slack",
  authenticationMethods: {
    oauth2Bot: {
      name: "OAuth2 (Bot)",
      description: "Authenticate as a bot. This is the recommended method.",
      type: "oauth2",
      client: {
        id: {
          envName: "CLOUD_SLACK_CLIENT_ID",
        },
        secret: {
          envName: "CLOUD_SLACK_CLIENT_SECRET",
        },
      },
      config: {
        authorization: {
          url: "https://slack.com/oauth/v2/authorize",
          scopeSeparator: ",",
        },
        token: {
          url: "https://slack.com/api/oauth.v2.access",
          metadata: {
            accountPointer: "/team/name",
          },
        },
        refresh: {
          url: "https://slack.com/api/oauth.v2.access",
        },
        appHostEnvName: "CLOUD_SLACK_APP_HOST",
      },
      scopes: [
        {
          name: "app_mentions:read",
          description:
            "View messages that directly mention @your_slack_app in conversations that the app is in",
        },

        {
          name: "bookmarks:read",
          description: "List bookmarks",
        },

        {
          name: "bookmarks:write",
          description: "Create, edit, and remove bookmarks",
        },

        {
          name: "calls:read",
          description: "View information about ongoing and past calls",
        },

        {
          name: "calls:write",
          description: "Start and manage calls in a workspace",
        },

        {
          name: "channels:history",
          description:
            "View messages and other content in public channels that your slack app has been added to",
        },

        {
          name: "channels:join",
          description: "Join public channels in a workspace",
          defaultChecked: true,
        },
        {
          name: "channels:manage",
          description:
            "Manage public channels that your slack app has been added to and create new ones",
        },
        {
          name: "channels:read",
          description:
            "View basic information about public channels in a workspace",
        },

        {
          name: "channels:write",
          description:
            "Manage a user’s public channels and create new ones on a user’s behalf",
        },
        {
          name: "channels:write.invites",
          description: "Invite members to public channels",
        },

        {
          name: "channels:write.topic",
          description: "Set the description of public channels",
        },

        {
          name: "chat:write",
          description: "Post messages in approved channels & conversations",
          defaultChecked: true,
        },

        {
          name: "chat:write.customize",
          description:
            "Send messages as @your_slack_app with a customized username and avatar",
          defaultChecked: true,
        },
        {
          name: "chat:write.public",
          description:
            "Send messages to channels @your_slack_app isn't a member of",
          defaultChecked: true,
        },

        {
          name: "commands",
          description:
            "Add shortcuts and/or slash commands that people can use",
        },

        {
          name: "conversations.connect:manage",
          description: "Allows your slack app to manage Slack Connect channels",
        },
        {
          name: "conversations.connect:read",
          description:
            "Receive Slack Connect invite events sent to the channels your slack app is in",
        },
        {
          name: "conversations.connect:write",
          description:
            "Create Slack Connect invitations for channels that your slack app has been added to, and accept invitations sent to your slack app",
        },
        {
          name: "dnd:read",
          description: "View Do Not Disturb settings for people in a workspace",
        },

        {
          name: "emoji:read",
          description: "View custom emoji in a workspace",
        },

        {
          name: "files:read",
          description:
            "View files shared in channels and conversations that your slack app has been added to",
        },

        {
          name: "files:write",
          description: "Upload, edit, and delete files as your slack app",
        },

        {
          name: "groups:history",
          description:
            "View messages and other content in private channels that your slack app has been added to",
        },

        {
          name: "groups:read",
          description:
            "View basic information about private channels that your slack app has been added to",
        },

        {
          name: "groups:write",
          description:
            "Manage private channels that your slack app has been added to and create new ones",
        },

        {
          name: "groups:write.invites",
          description: "Invite members to private channels",
        },

        {
          name: "groups:write.topic",
          description: "Set the description of private channels",
        },

        {
          name: "im:history",
          description:
            "View messages and other content in direct messages that your slack app has been added to",
        },

        {
          name: "im:read",
          description:
            "View basic information about direct messages that your slack app has been added to",
        },

        {
          name: "im:write",
          description: "Start direct messages with people",
        },

        {
          name: "incoming-webhook",
          description:
            "Create one-way webhooks to post messages to a specific channel",
        },

        {
          name: "links.embed:write",
          description: "Embed video player URLs in messages and app surfaces",
        },

        {
          name: "links:read",
          description: "View URLs in messages",
        },

        {
          name: "links:write",
          description: "Show previews of URLs in messages",
        },

        {
          name: "metadata.message:read",
          description:
            "Allows your slack app to read message metadata in channels that your slack app has been added to",
        },
        {
          name: "mpim:history",
          description:
            "View messages and other content in group direct messages that your slack app has been added to",
        },

        {
          name: "mpim:read",
          description:
            "View basic information about group direct messages that your slack app has been added to",
        },

        {
          name: "mpim:write",
          description: "Start group direct messages with people",
        },

        {
          name: "mpim:write.invites",
          description: "Invite members to group direct messages",
        },

        {
          name: "mpim:write.topic",
          description: "Set the description in group direct messages",
        },

        {
          name: "none",
          description: "Execute methods without needing a scope",
        },

        {
          name: "pins:read",
          description:
            "View pinned content in channels and conversations that your slack app has been added to",
        },

        {
          name: "pins:write",
          description: "Add and remove pinned messages and files",
        },

        {
          name: "reactions:read",
          description:
            "View emoji reactions and their associated content in channels and conversations that your slack app has been added to",
        },

        {
          name: "reactions:write",
          description: "Add and edit emoji reactions",
        },

        {
          name: "reminders:read",
          description: "View reminders created by your slack app",
        },

        {
          name: "reminders:write",
          description: "Add, remove, or mark reminders as complete",
        },

        {
          name: "remote_files:read",
          description: "View remote files added by the app in a workspace",
        },

        {
          name: "remote_files:share",
          description: "Share remote files on a user’s behalf",
        },

        {
          name: "remote_files:write",
          description: "Add, edit, and delete remote files on a user’s behalf",
        },

        {
          name: "search:read.public",
          description: "Search a workspace's messages in public channels",
        },

        {
          name: "team.billing:read",
          description:
            "Allows your slack app to read the billing plan for workspaces your slack app has been installed to",
        },

        {
          name: "team.preferences:read",
          description:
            "Allows your slack app to read the preferences for workspaces your slack app has been installed to",
        },

        {
          name: "team:read",
          description:
            "View the name, email domain, and icon for workspaces your slack app is connected to",
        },

        {
          name: "tokens.basic",
          description: "Execute methods without needing a scope",
        },

        {
          name: "triggers:read",
          description: "Read new Platform triggers",
        },
        {
          name: "triggers:write",
          description: "Create new Platform triggers",
        },
        {
          name: "usergroups:read",
          description: "View user groups in a workspace",
        },

        {
          name: "usergroups:write",
          description: "Create and manage user groups",
        },

        {
          name: "users.profile:read",
          description: "View profile details about people in a workspace",
        },

        {
          name: "users:read",
          description: "View people in a workspace",
        },

        {
          name: "users:read.email",
          description: "View email addresses of people in a workspace",
        },

        {
          name: "users:write",
          description: "Set presence for your slack app",
        },

        {
          name: "workflow.steps:execute",
          description: "Add steps that people can use in Workflow Builder",
        },
      ],
      help,
    },
    oauth2User: {
      name: "OAuth2 (User)",
      description: "Authenticate as a user",
      type: "oauth2",
      client: {
        id: {
          envName: "CLOUD_SLACK_CLIENT_ID",
        },
        secret: {
          envName: "CLOUD_SLACK_CLIENT_SECRET",
        },
      },
      config: {
        authorization: {
          url: "https://slack.com/oauth/v2/authorize",
          scopeSeparator: ",",
          scopeParamName: "user_scope",
        },
        token: {
          url: "https://slack.com/api/oauth.v2.access",
          metadata: {
            accountPointer: "/team/name",
          },
          accessTokenPointer: "/authed_user/access_token",
          scopePointer: "/authed_user/scope",
        },
        refresh: {
          url: "https://slack.com/api/oauth.v2.access",
        },
        appHostEnvName: "CLOUD_SLACK_APP_HOST",
      },
      scopes: [
        {
          name: "admin",
          description: "Administer a workspace",
        },
        {
          name: "admin.analytics:read",
          description: "Access analytics data about the organization",
        },
        {
          name: "admin.apps:read",
          description: "View apps and app requests in a workspace",
        },
        {
          name: "admin.apps:write",
          description: "Manage apps in a workspace",
        },
        {
          name: "admin.barriers:read",
          description: "Read information barriers in the organization",
        },
        {
          name: "admin.barriers:write",
          description: "Manage information barriers in the organization",
        },
        {
          name: "admin.conversations:read",
          description:
            "View the channel’s member list, topic, purpose and channel name",
        },
        {
          name: "admin.conversations:write",
          description:
            "Start a new conversation, modify a conversation and modify channel details",
        },
        {
          name: "admin.invites:read",
          description:
            "Gain information about invite requests in a Grid organization.",
        },
        {
          name: "admin.invites:write",
          description:
            "Approve or deny invite requests in a Grid organization.",
        },
        {
          name: "admin.roles:read",
          description: "List role assignments for your workspace.",
        },
        {
          name: "admin.roles:write",
          description: "Add and remove role assignments for your workspace.",
        },
        {
          name: "admin.teams:read",
          description: "Access information about a workspace",
        },
        {
          name: "admin.teams:write",
          description: "Make changes to a workspace",
        },
        {
          name: "admin.usergroups:read",
          description: "Access information about user groups",
        },
        {
          name: "admin.usergroups:write",
          description: "Make changes to your usergroups",
        },
        {
          name: "admin.users:read",
          description: "Access a workspace’s profile information",
        },
        {
          name: "admin.users:write",
          description: "Modify account information",
        },
        {
          name: "admin.workflows:read",
          description: "View all workflows in a workspace",
        },
        {
          name: "admin.workflows:write",
          description: "Manage workflows in a workspace",
        },

        {
          name: "auditlogs:read",
          description:
            "View events from all workspaces, channels and users (Enterprise Grid only)",
        },

        {
          name: "bookmarks:read",
          description: "List bookmarks",
        },

        {
          name: "bookmarks:write",
          description: "Create, edit, and remove bookmarks",
        },

        {
          name: "calls:read",
          description: "View information about ongoing and past calls",
        },

        {
          name: "calls:write",
          description: "Start and manage calls in a workspace",
        },

        {
          name: "channels:history",
          description:
            "View messages and other content in public channels that your slack app has been added to",
        },

        {
          name: "channels:read",
          description:
            "View basic information about public channels in a workspace",
        },

        {
          name: "channels:write.invites",
          description: "Invite members to public channels",
        },

        {
          name: "channels:write.topic",
          description: "Set the description of public channels",
        },

        {
          name: "chat:write",
          description: "Post messages in approved channels & conversations",
        },

        {
          name: "chat:write:bot",
          description: "Send messages as your slack app",
          defaultChecked: true,
        },
        {
          name: "chat:write:user",
          description: "Send messages on a user’s behalf",
          defaultChecked: true,
        },

        {
          name: "commands",
          description:
            "Add shortcuts and/or slash commands that people can use",
        },

        {
          name: "dnd:read",
          description: "View Do Not Disturb settings for people in a workspace",
        },
        {
          name: "dnd:write",
          description: "Edit a user’s Do Not Disturb settings",
        },
        {
          name: "email",
          description: "View a user’s email address",
        },

        {
          name: "emoji:read",
          description: "View custom emoji in a workspace",
        },

        {
          name: "files:read",
          description:
            "View files shared in channels and conversations that your slack app has been added to",
        },

        {
          name: "files:write",
          description: "Upload, edit, and delete files as your slack app",
        },
        {
          name: "files:write:user",
          description: "Upload, edit, and delete files as your slack app",
        },

        {
          name: "groups:history",
          description:
            "View messages and other content in private channels that your slack app has been added to",
        },
        {
          name: "groups:read",
          description:
            "View basic information about private channels that your slack app has been added to",
        },
        {
          name: "groups:write",
          description:
            "Manage private channels that your slack app has been added to and create new ones",
        },

        {
          name: "groups:write.invites",
          description: "Invite members to private channels",
        },

        {
          name: "groups:write.topic",
          description: "Set the description of private channels",
        },
        {
          name: "identity.avatar",
          description: "View a user’s Slack avatar",
        },
        {
          name: "identity.basic",
          description: "View information about a user’s identity",
        },
        {
          name: "identity.email",
          description: "View a user’s email address",
        },
        {
          name: "identity.team",
          description: "View a user’s Slack workspace name",
        },

        {
          name: "im:history",
          description:
            "View messages and other content in direct messages that your slack app has been added to",
        },

        {
          name: "im:read",
          description:
            "View basic information about direct messages that your slack app has been added to",
        },

        {
          name: "im:write",
          description: "Start direct messages with people",
        },

        {
          name: "incoming-webhook",
          description:
            "Create one-way webhooks to post messages to a specific channel",
        },

        {
          name: "links.embed:write",
          description: "Embed video player URLs in messages and app surfaces",
        },

        {
          name: "links:read",
          description: "View URLs in messages",
        },

        {
          name: "links:write",
          description: "Show previews of URLs in messages",
        },

        {
          name: "mpim:history",
          description:
            "View messages and other content in group direct messages that your slack app has been added to",
        },

        {
          name: "mpim:read",
          description:
            "View basic information about group direct messages that your slack app has been added to",
        },

        {
          name: "mpim:write",
          description: "Start group direct messages with people",
        },

        {
          name: "mpim:write.invites",
          description: "Invite members to group direct messages",
        },

        {
          name: "mpim:write.topic",
          description: "Set the description in group direct messages",
        },

        {
          name: "openid",
          description: "View information about a user’s identity",
        },

        {
          name: "pins:read",
          description:
            "View pinned content in channels and conversations that your slack app has been added to",
        },

        {
          name: "pins:write",
          description: "Add and remove pinned messages and files",
        },
        {
          name: "profile",
          description:
            "View a user’s Slack avatar and Slack workspace's basic information",
        },

        {
          name: "reactions:read",
          description:
            "View emoji reactions and their associated content in channels and conversations that your slack app has been added to",
        },

        {
          name: "reactions:write",
          description: "Add and edit emoji reactions",
        },

        {
          name: "reminders:read",
          description: "View reminders created by your slack app",
        },

        {
          name: "reminders:write",
          description: "Add, remove, or mark reminders as complete",
        },

        {
          name: "remote_files:read",
          description: "View remote files added by the app in a workspace",
        },

        {
          name: "remote_files:share",
          description: "Share remote files on a user’s behalf",
        },

        {
          name: "search:read",
          description: "Search a workspace’s content",
        },

        {
          name: "stars:read",
          description:
            "View messages and files that your slack app has starred",
        },
        {
          name: "stars:write",
          description: "Add or remove stars",
        },

        {
          name: "team.billing:read",
          description:
            "Allows your slack app to read the billing plan for workspaces your slack app has been installed to",
        },

        {
          name: "team.preferences:read",
          description:
            "Allows your slack app to read the preferences for workspaces your slack app has been installed to",
        },

        {
          name: "team:read",
          description:
            "View the name, email domain, and icon for workspaces your slack app is connected to",
        },

        {
          name: "tokens.basic",
          description: "Execute methods without needing a scope",
        },

        {
          name: "usergroups:read",
          description: "View user groups in a workspace",
        },

        {
          name: "usergroups:write",
          description: "Create and manage user groups",
        },

        {
          name: "users.profile:read",
          description: "View profile details about people in a workspace",
        },
        {
          name: "users.profile:write",
          description: "Edit a user’s profile information and status",
        },

        {
          name: "users:read",
          description: "View people in a workspace",
        },

        {
          name: "users:read.email",
          description: "View email addresses of people in a workspace",
        },

        {
          name: "users:write",
          description: "Set presence for your slack app",
        },
      ],
      help,
    },
  },
};
