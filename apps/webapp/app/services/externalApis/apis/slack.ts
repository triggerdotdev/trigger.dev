import type { ExternalAPI, ScopeAnnotation } from "../types";

const userAnnotation: ScopeAnnotation = {
  label: "User",
  color: "#00FFA3",
};

const botAnnotation: ScopeAnnotation = {
  label: "Bot",
  color: "#FFF067",
};

export const slack: ExternalAPI = {
  identifier: "slack",
  name: "Slack",
  authenticationMethods: {
    oauth2Bot: {
      name: "OAuth2 (Bot)",
      type: "oauth2",
      client: {
        id: {
          envName: "EXTERNAL_SLACK_CLIENT_ID",
        },
        secret: {
          envName: "EXTERNAL_SLACK_CLIENT_SECRET",
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
        appHostEnvName: "EXTERNAL_SLACK_APP_HOST",
      },
      scopes: [
        {
          name: "app_mentions:read",
          description:
            "View messages that directly mention @your_slack_app in conversations that the app is in",
          annotations: [botAnnotation],
        },

        {
          name: "bookmarks:read",
          description: "List bookmarks",
          annotations: [botAnnotation],
        },

        {
          name: "bookmarks:write",
          description: "Create, edit, and remove bookmarks",
          annotations: [botAnnotation],
        },

        {
          name: "calls:read",
          description: "View information about ongoing and past calls",
          annotations: [botAnnotation],
        },

        {
          name: "calls:write",
          description: "Start and manage calls in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "channels:history",
          description:
            "View messages and other content in public channels that your slack app has been added to",
          annotations: [botAnnotation],
        },

        {
          name: "channels:join",
          description: "Join public channels in a workspace",
          annotations: [botAnnotation],
        },
        {
          name: "channels:manage",
          description:
            "Manage public channels that your slack app has been added to and create new ones",
          annotations: [botAnnotation],
        },
        {
          name: "channels:read",
          description:
            "View basic information about public channels in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "channels:write",
          description:
            "Manage a user’s public channels and create new ones on a user’s behalf",
          annotations: [botAnnotation],
        },
        {
          name: "channels:write.invites",
          description: "Invite members to public channels",
          annotations: [botAnnotation],
        },

        {
          name: "channels:write.topic",
          description: "Set the description of public channels",
          annotations: [botAnnotation],
        },

        {
          name: "chat:write",
          description: "Post messages in approved channels & conversations",
          annotations: [botAnnotation],
        },

        {
          name: "chat:write.customize",
          description:
            "Send messages as @your_slack_app with a customized username and avatar",
          annotations: [botAnnotation],
        },
        {
          name: "chat:write.public",
          description:
            "Send messages to channels @your_slack_app isn't a member of",
          annotations: [botAnnotation],
        },

        {
          name: "commands",
          description:
            "Add shortcuts and/or slash commands that people can use",
          annotations: [botAnnotation],
        },

        {
          name: "conversations.connect:manage",
          description: "Allows your slack app to manage Slack Connect channels",
          annotations: [botAnnotation],
        },
        {
          name: "conversations.connect:read",
          description:
            "Receive Slack Connect invite events sent to the channels your slack app is in",
          annotations: [botAnnotation],
        },
        {
          name: "conversations.connect:write",
          description:
            "Create Slack Connect invitations for channels that your slack app has been added to, and accept invitations sent to your slack app",
          annotations: [botAnnotation],
        },
        {
          name: "dnd:read",
          description: "View Do Not Disturb settings for people in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "emoji:read",
          description: "View custom emoji in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "files:read",
          description:
            "View files shared in channels and conversations that your slack app has been added to",
          annotations: [botAnnotation],
        },

        {
          name: "files:write",
          description: "Upload, edit, and delete files as your slack app",
          annotations: [botAnnotation],
        },

        {
          name: "groups:history",
          description:
            "View messages and other content in private channels that your slack app has been added to",
          annotations: [botAnnotation],
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
          annotations: [botAnnotation],
        },

        {
          name: "groups:write.topic",
          description: "Set the description of private channels",
          annotations: [botAnnotation],
        },

        {
          name: "im:history",
          description:
            "View messages and other content in direct messages that your slack app has been added to",
          annotations: [botAnnotation],
        },

        {
          name: "im:read",
          description:
            "View basic information about direct messages that your slack app has been added to",
          annotations: [botAnnotation],
        },

        {
          name: "im:write",
          description: "Start direct messages with people",
          annotations: [botAnnotation],
        },

        {
          name: "incoming-webhook",
          description:
            "Create one-way webhooks to post messages to a specific channel",
          annotations: [botAnnotation],
        },

        {
          name: "links.embed:write",
          description: "Embed video player URLs in messages and app surfaces",
          annotations: [botAnnotation],
        },

        {
          name: "links:read",
          description: "View URLs in messages",
          annotations: [botAnnotation],
        },

        {
          name: "links:write",
          description: "Show previews of URLs in messages",
          annotations: [botAnnotation],
        },

        {
          name: "metadata.message:read",
          description:
            "Allows your slack app to read message metadata in channels that your slack app has been added to",
          annotations: [botAnnotation],
        },
        {
          name: "mpim:history",
          description:
            "View messages and other content in group direct messages that your slack app has been added to",
          annotations: [botAnnotation],
        },

        {
          name: "mpim:read",
          description:
            "View basic information about group direct messages that your slack app has been added to",
          annotations: [botAnnotation],
        },

        {
          name: "mpim:write",
          description: "Start group direct messages with people",
          annotations: [botAnnotation],
        },

        {
          name: "mpim:write.invites",
          description: "Invite members to group direct messages",
          annotations: [botAnnotation],
        },

        {
          name: "mpim:write.topic",
          description: "Set the description in group direct messages",
          annotations: [botAnnotation],
        },

        {
          name: "none",
          description: "Execute methods without needing a scope",
          annotations: [botAnnotation],
        },

        {
          name: "pins:read",
          description:
            "View pinned content in channels and conversations that your slack app has been added to",
          annotations: [botAnnotation],
        },

        {
          name: "pins:write",
          description: "Add and remove pinned messages and files",
          annotations: [botAnnotation],
        },

        {
          name: "reactions:read",
          description:
            "View emoji reactions and their associated content in channels and conversations that your slack app has been added to",
          annotations: [botAnnotation],
        },

        {
          name: "reactions:write",
          description: "Add and edit emoji reactions",
          annotations: [botAnnotation],
        },

        {
          name: "reminders:read",
          description: "View reminders created by your slack app",
          annotations: [botAnnotation],
        },

        {
          name: "reminders:write",
          description: "Add, remove, or mark reminders as complete",
          annotations: [botAnnotation],
        },

        {
          name: "remote_files:read",
          description: "View remote files added by the app in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "remote_files:share",
          description: "Share remote files on a user’s behalf",
          annotations: [botAnnotation],
        },

        {
          name: "remote_files:write",
          description: "Add, edit, and delete remote files on a user’s behalf",
          annotations: [botAnnotation],
        },

        {
          name: "search:read.public",
          description: "Search a workspace's messages in public channels",
          annotations: [botAnnotation],
        },

        {
          name: "team.billing:read",
          description:
            "Allows your slack app to read the billing plan for workspaces your slack app has been installed to",
          annotations: [botAnnotation],
        },

        {
          name: "team.preferences:read",
          description:
            "Allows your slack app to read the preferences for workspaces your slack app has been installed to",
          annotations: [botAnnotation],
        },

        {
          name: "team:read",
          description:
            "View the name, email domain, and icon for workspaces your slack app is connected to",
          annotations: [botAnnotation],
        },

        {
          name: "tokens.basic",
          description: "Execute methods without needing a scope",
          annotations: [botAnnotation],
        },

        {
          name: "triggers:read",
          description: "Read new Platform triggers",
          annotations: [botAnnotation],
        },
        {
          name: "triggers:write",
          description: "Create new Platform triggers",
          annotations: [botAnnotation],
        },
        {
          name: "usergroups:read",
          description: "View user groups in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "usergroups:write",
          description: "Create and manage user groups",
          annotations: [botAnnotation],
        },

        {
          name: "users.profile:read",
          description: "View profile details about people in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "users:read",
          description: "View people in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "users:read.email",
          description: "View email addresses of people in a workspace",
          annotations: [botAnnotation],
        },

        {
          name: "users:write",
          description: "Set presence for your slack app",
          annotations: [botAnnotation],
        },

        {
          name: "workflow.steps:execute",
          description: "Add steps that people can use in Workflow Builder",
          annotations: [botAnnotation],
        },
      ],
    },
    oauth2User: {
      name: "OAuth2 (User)",
      type: "oauth2",
      client: {
        id: {
          envName: "EXTERNAL_SLACK_CLIENT_ID",
        },
        secret: {
          envName: "EXTERNAL_SLACK_CLIENT_SECRET",
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
        },
        refresh: {
          url: "https://slack.com/api/oauth.v2.access",
        },
        appHostEnvName: "EXTERNAL_SLACK_APP_HOST",
      },
      scopes: [
        {
          name: "admin",
          description: "Administer a workspace",
          annotations: [userAnnotation],
        },
        {
          name: "admin.analytics:read",
          description: "Access analytics data about the organization",

          annotations: [userAnnotation],
        },
        {
          name: "admin.apps:read",
          description: "View apps and app requests in a workspace",

          annotations: [userAnnotation],
        },
        {
          name: "admin.apps:write",
          description: "Manage apps in a workspace",

          annotations: [userAnnotation],
        },
        {
          name: "admin.barriers:read",
          description: "Read information barriers in the organization",

          annotations: [userAnnotation],
        },
        {
          name: "admin.barriers:write",
          description: "Manage information barriers in the organization",

          annotations: [userAnnotation],
        },
        {
          name: "admin.conversations:read",
          description:
            "View the channel’s member list, topic, purpose and channel name",

          annotations: [userAnnotation],
        },
        {
          name: "admin.conversations:write",
          description:
            "Start a new conversation, modify a conversation and modify channel details",

          annotations: [userAnnotation],
        },
        {
          name: "admin.invites:read",
          description:
            "Gain information about invite requests in a Grid organization.",

          annotations: [userAnnotation],
        },
        {
          name: "admin.invites:write",
          description:
            "Approve or deny invite requests in a Grid organization.",

          annotations: [userAnnotation],
        },
        {
          name: "admin.roles:read",
          description: "List role assignments for your workspace.",

          annotations: [userAnnotation],
        },
        {
          name: "admin.roles:write",
          description: "Add and remove role assignments for your workspace.",

          annotations: [userAnnotation],
        },
        {
          name: "admin.teams:read",
          description: "Access information about a workspace",

          annotations: [userAnnotation],
        },
        {
          name: "admin.teams:write",
          description: "Make changes to a workspace",

          annotations: [userAnnotation],
        },
        {
          name: "admin.usergroups:read",
          description: "Access information about user groups",

          annotations: [userAnnotation],
        },
        {
          name: "admin.usergroups:write",
          description: "Make changes to your usergroups",

          annotations: [userAnnotation],
        },
        {
          name: "admin.users:read",
          description: "Access a workspace’s profile information",

          annotations: [userAnnotation],
        },
        {
          name: "admin.users:write",
          description: "Modify account information",

          annotations: [userAnnotation],
        },
        {
          name: "admin.workflows:read",
          description: "View all workflows in a workspace",

          annotations: [userAnnotation],
        },
        {
          name: "admin.workflows:write",
          description: "Manage workflows in a workspace",

          annotations: [userAnnotation],
        },

        {
          name: "auditlogs:read",
          description:
            "View events from all workspaces, channels and users (Enterprise Grid only)",

          annotations: [userAnnotation],
        },

        {
          name: "bookmarks:read",
          description: "List bookmarks",

          annotations: [userAnnotation],
        },

        {
          name: "bookmarks:write",
          description: "Create, edit, and remove bookmarks",

          annotations: [userAnnotation],
        },

        {
          name: "calls:read",
          description: "View information about ongoing and past calls",

          annotations: [userAnnotation],
        },

        {
          name: "calls:write",
          description: "Start and manage calls in a workspace",

          annotations: [userAnnotation],
        },

        {
          name: "channels:history",
          description:
            "View messages and other content in public channels that your slack app has been added to",

          annotations: [userAnnotation],
        },

        {
          name: "channels:read",
          description:
            "View basic information about public channels in a workspace",

          annotations: [userAnnotation],
        },

        {
          name: "channels:write.invites",
          description: "Invite members to public channels",

          annotations: [userAnnotation],
        },

        {
          name: "channels:write.topic",
          description: "Set the description of public channels",

          annotations: [userAnnotation],
        },

        {
          name: "chat:write",
          description: "Post messages in approved channels & conversations",

          annotations: [userAnnotation],
        },

        {
          name: "chat:write:bot",
          description: "Send messages as your slack app",

          annotations: [userAnnotation],
        },
        {
          name: "chat:write:user",
          description: "Send messages on a user’s behalf",

          annotations: [userAnnotation],
        },

        {
          name: "commands",
          description:
            "Add shortcuts and/or slash commands that people can use",

          annotations: [userAnnotation],
        },

        {
          name: "dnd:read",
          description: "View Do Not Disturb settings for people in a workspace",

          annotations: [userAnnotation],
        },
        {
          name: "dnd:write",
          description: "Edit a user’s Do Not Disturb settings",

          annotations: [userAnnotation],
        },
        {
          name: "email",
          description: "View a user’s email address",

          annotations: [userAnnotation],
        },

        {
          name: "emoji:read",
          description: "View custom emoji in a workspace",

          annotations: [userAnnotation],
        },

        {
          name: "files:read",
          description:
            "View files shared in channels and conversations that your slack app has been added to",

          annotations: [userAnnotation],
        },

        {
          name: "files:write",
          description: "Upload, edit, and delete files as your slack app",

          annotations: [userAnnotation],
        },
        {
          name: "files:write:user",
          description: "Upload, edit, and delete files as your slack app",

          annotations: [userAnnotation],
        },

        {
          name: "groups:history",
          description:
            "View messages and other content in private channels that your slack app has been added to",

          annotations: [userAnnotation],
        },
        {
          name: "groups:read",
          description:
            "View basic information about private channels that your slack app has been added to",
        },
        {
          name: "groups:read",
          description:
            "View basic information about private channels that your slack app has been added to",

          annotations: [userAnnotation],
        },
        {
          name: "groups:write",
          description:
            "Manage private channels that your slack app has been added to and create new ones",
        },
        {
          name: "groups:write",
          description:
            "Manage private channels that your slack app has been added to and create new ones",

          annotations: [userAnnotation],
        },

        {
          name: "groups:write.invites",
          description: "Invite members to private channels",

          annotations: [userAnnotation],
        },

        {
          name: "groups:write.topic",
          description: "Set the description of private channels",

          annotations: [userAnnotation],
        },
        {
          name: "identity.avatar",
          description: "View a user’s Slack avatar",

          annotations: [userAnnotation],
        },
        {
          name: "identity.basic",
          description: "View information about a user’s identity",

          annotations: [userAnnotation],
        },
        {
          name: "identity.email",
          description: "View a user’s email address",

          annotations: [userAnnotation],
        },
        {
          name: "identity.team",
          description: "View a user’s Slack workspace name",

          annotations: [userAnnotation],
        },

        {
          name: "im:history",
          description:
            "View messages and other content in direct messages that your slack app has been added to",

          annotations: [userAnnotation],
        },

        {
          name: "im:read",
          description:
            "View basic information about direct messages that your slack app has been added to",

          annotations: [userAnnotation],
        },

        {
          name: "im:write",
          description: "Start direct messages with people",

          annotations: [userAnnotation],
        },

        {
          name: "incoming-webhook",
          description:
            "Create one-way webhooks to post messages to a specific channel",

          annotations: [userAnnotation],
        },

        {
          name: "links.embed:write",
          description: "Embed video player URLs in messages and app surfaces",

          annotations: [userAnnotation],
        },

        {
          name: "links:read",
          description: "View URLs in messages",

          annotations: [userAnnotation],
        },

        {
          name: "links:write",
          description: "Show previews of URLs in messages",

          annotations: [userAnnotation],
        },

        {
          name: "mpim:history",
          description:
            "View messages and other content in group direct messages that your slack app has been added to",

          annotations: [userAnnotation],
        },

        {
          name: "mpim:read",
          description:
            "View basic information about group direct messages that your slack app has been added to",

          annotations: [userAnnotation],
        },

        {
          name: "mpim:write",
          description: "Start group direct messages with people",

          annotations: [userAnnotation],
        },

        {
          name: "mpim:write.invites",
          description: "Invite members to group direct messages",

          annotations: [userAnnotation],
        },

        {
          name: "mpim:write.topic",
          description: "Set the description in group direct messages",

          annotations: [userAnnotation],
        },

        {
          name: "openid",
          description: "View information about a user’s identity",

          annotations: [userAnnotation],
        },

        {
          name: "pins:read",
          description:
            "View pinned content in channels and conversations that your slack app has been added to",

          annotations: [userAnnotation],
        },

        {
          name: "pins:write",
          description: "Add and remove pinned messages and files",

          annotations: [userAnnotation],
        },
        {
          name: "profile",
          description:
            "View a user’s Slack avatar and Slack workspace's basic information",

          annotations: [userAnnotation],
        },

        {
          name: "reactions:read",
          description:
            "View emoji reactions and their associated content in channels and conversations that your slack app has been added to",

          annotations: [userAnnotation],
        },

        {
          name: "reactions:write",
          description: "Add and edit emoji reactions",

          annotations: [userAnnotation],
        },

        {
          name: "reminders:read",
          description: "View reminders created by your slack app",

          annotations: [userAnnotation],
        },

        {
          name: "reminders:write",
          description: "Add, remove, or mark reminders as complete",

          annotations: [userAnnotation],
        },

        {
          name: "remote_files:read",
          description: "View remote files added by the app in a workspace",

          annotations: [userAnnotation],
        },

        {
          name: "remote_files:share",
          description: "Share remote files on a user’s behalf",

          annotations: [userAnnotation],
        },

        {
          name: "search:read",
          description: "Search a workspace’s content",

          annotations: [userAnnotation],
        },

        {
          name: "stars:read",
          description:
            "View messages and files that your slack app has starred",

          annotations: [userAnnotation],
        },
        {
          name: "stars:write",
          description: "Add or remove stars",

          annotations: [userAnnotation],
        },

        {
          name: "team.billing:read",
          description:
            "Allows your slack app to read the billing plan for workspaces your slack app has been installed to",

          annotations: [userAnnotation],
        },

        {
          name: "team.preferences:read",
          description:
            "Allows your slack app to read the preferences for workspaces your slack app has been installed to",

          annotations: [userAnnotation],
        },

        {
          name: "team:read",
          description:
            "View the name, email domain, and icon for workspaces your slack app is connected to",

          annotations: [userAnnotation],
        },

        {
          name: "tokens.basic",
          description: "Execute methods without needing a scope",

          annotations: [userAnnotation],
        },

        {
          name: "usergroups:read",
          description: "View user groups in a workspace",

          annotations: [userAnnotation],
        },

        {
          name: "usergroups:write",
          description: "Create and manage user groups",

          annotations: [userAnnotation],
        },

        {
          name: "users.profile:read",
          description: "View profile details about people in a workspace",

          annotations: [userAnnotation],
        },
        {
          name: "users.profile:write",
          description: "Edit a user’s profile information and status",

          annotations: [userAnnotation],
        },

        {
          name: "users:read",
          description: "View people in a workspace",

          annotations: [userAnnotation],
        },

        {
          name: "users:read.email",
          description: "View email addresses of people in a workspace",

          annotations: [userAnnotation],
        },

        {
          name: "users:write",
          description: "Set presence for your slack app",

          annotations: [userAnnotation],
        },
      ],
    },
  },
};
