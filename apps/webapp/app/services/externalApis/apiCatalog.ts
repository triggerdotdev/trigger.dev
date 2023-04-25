import type { ExternalAPI } from "./types";

const slack: ExternalAPI = {
  identifier: "slack",
  name: "Slack",
  authenticationMethods: {
    oauth2: {
      name: "OAuth2",
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
          scopeSeparator: " ",
        },
        token: {
          url: "https://slack.com/api/oauth.v2.access",
        },
        refresh: {
          url: "https://slack.com/api/oauth.v2.access",
        },
        appHostEnvName: "EXTERNAL_SLACK_APP_HOST",
      },
      scopes: [
        { name: "admin", description: "Administer a workspace" },
        {
          name: "admin.analytics:read",
          description: "Access analytics data about the organization",
        },
        {
          name: "admin.apps:read",
          description: "View apps and app requests in a workspace",
        },
        { name: "admin.apps:write", description: "Manage apps in a workspace" },
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
          name: "app_configurations:read",
          description: "Read app configuration info via App Manifest APIs",
        },
        {
          name: "app_configurations:write",
          description:
            "Write app configuration info and create apps via App Manifest APIs",
        },
        {
          name: "app_mentions:read",
          description:
            "View messages that directly mention @your_slack_app in conversations that the app is in",
        },
        {
          name: "auditlogs:read",
          description:
            "View events from all workspaces, channels and users (Enterprise Grid only)",
        },
        {
          name: "authorizations:read",
          description:
            "Grants permission to list authorizations associated with the Events API",
        },
        { name: "bookmarks:read", description: "List bookmarks" },
        {
          name: "bookmarks:write",
          description: "Create, edit, and remove bookmarks",
        },
        {
          name: "bot",
          description:
            "Add the ability for people to direct message or mention @your_slack_app",
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
        },
        {
          name: "chat:write.customize",
          description:
            "Send messages as @your_slack_app with a customized username and avatar",
        },
        {
          name: "chat:write.public",
          description:
            "Send messages to channels @your_slack_app isn't a member of",
        },
        {
          name: "chat:write:bot",
          description: "Send messages as your slack app",
        },
        {
          name: "chat:write:user",
          description: "Send messages on a user’s behalf",
        },
        {
          name: "client",
          description: "Receive all events from a workspace in real time",
        },
        {
          name: "commands",
          description:
            "Add shortcuts and/or slash commands that people can use",
        },
        {
          name: "connections:write",
          description:
            "Grants permission to generate websocket URIs and connect to Socket Mode",
        },
        {
          name: "conversations.app_home:create",
          description:
            "Deprecated: Create an app home conversation with a user for legacy workspace apps",
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
          name: "conversations:history",
          description:
            "Deprecated: Retrieve conversation history for legacy workspace apps",
        },
        {
          name: "conversations:read",
          description:
            "Deprecated: Retrieve information on conversations for legacy workspace apps",
        },
        {
          name: "conversations:write",
          description:
            "Deprecated: Edit conversation attributes for legacy workspace apps",
        },
        {
          name: "conversations:write.invites",
          description: "Invite members to conversations",
        },
        {
          name: "conversations:write.topic",
          description: "Set the description of conversations",
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
          name: "dnd:write:user",
          description: "Change the user's Do Not Disturb settings",
        },
        { name: "email", description: "View a user’s email address" },
        { name: "emoji:read", description: "View custom emoji in a workspace" },
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
          name: "identify",
          description: "View information about a user’s identity",
        },
        { name: "identity.avatar", description: "View a user’s Slack avatar" },
        {
          name: "identity.avatar:read:user",
          description: "View the user's profile picture",
        },
        {
          name: "identity.basic",
          description: "View information about a user’s identity",
        },
        { name: "identity.email", description: "View a user’s email address" },
        { name: "identity.email:read:user" },
        {
          name: "identity.team",
          description: "View a user’s Slack workspace name",
        },
        {
          name: "identity.team:read:user",
          description: "View the workspace's name, domain, and icon",
        },
        { name: "identity:read:user" },
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
        { name: "im:write", description: "Start direct messages with people" },
        {
          name: "incoming-webhook",
          description:
            "Create one-way webhooks to post messages to a specific channel",
        },
        {
          name: "links.embed:write",
          description: "Embed video player URLs in messages and app surfaces",
        },
        { name: "links:read", description: "View URLs in messages" },
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
        { name: "post", description: "Post messages to a workspace" },
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
        { name: "read", description: "View all content in a workspace" },
        {
          name: "reminders:read",
          description: "View reminders created by your slack app",
        },
        {
          name: "reminders:read:user",
          description: "Access reminders created by a user or for a user",
        },
        {
          name: "reminders:write",
          description: "Add, remove, or mark reminders as complete",
        },
        {
          name: "reminders:write:user",
          description: "Add, remove, or complete reminders for the user",
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
        { name: "search:read", description: "Search a workspace’s content" },
        {
          name: "search:read.public",
          description: "Search a workspace's messages in public channels",
        },
        {
          name: "stars:read",
          description:
            "View messages and files that your slack app has starred",
        },
        { name: "stars:write", description: "Add or remove stars" },
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
        { name: "triggers:read", description: "Read new Platform triggers" },
        { name: "triggers:write", description: "Create new Platform triggers" },
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
          name: "users.profile:write:user",
          description: "Change the user's profile fields",
        },
        { name: "users:read", description: "View people in a workspace" },
        {
          name: "users:read.email",
          description: "View email addresses of people in a workspace",
        },
        { name: "users:write", description: "Set presence for your slack app" },
        {
          name: "workflow.steps:execute",
          description: "Add steps that people can use in Workflow Builder",
        },
      ],
    },
  },
};

export const apis: Record<string, ExternalAPI> = { slack };
