# Trigger.dev CLI

A CLI that allows you to create, run locally and deploy Trigger.dev background tasks.

Note: this only works with Trigger.dev v3 projects and later. For older projects use the [@trigger.dev/cli](https://www.npmjs.com/package/@trigger.dev/cli) package.

Trigger.dev is an open source platform that makes it easy to create event-driven background tasks directly in your existing project.

## Commands

| Command                                                              | Description                                                        |
| :------------------------------------------------------------------- | :----------------------------------------------------------------- |
| [login](https://trigger.dev/docs/cli-login-commands)                 | Login with Trigger.dev so you can perform authenticated actions.   |
| [init](https://trigger.dev/docs/cli-init-commands)                   | Initialize your existing project for development with Trigger.dev. |
| [dev](https://trigger.dev/docs/cli-dev-commands)                     | Run your Trigger.dev tasks locally.                                |
| [deploy](https://trigger.dev/docs/cli-deploy-commands)               | Deploy your Trigger.dev v3 project to the cloud.                   |
| [whoami](https://trigger.dev/docs/cli-whoami-commands)               | Display the current logged in user and project details.            |
| [logout](https://trigger.dev/docs/cli-logout-commands)               | Logout of Trigger.dev.                                             |
| [list-profiles](https://trigger.dev/docs/cli-list-profiles-commands) | List all of your CLI profiles.                                     |
| [preview archive](https://trigger.dev/docs/cli-preview-archive)      | Archive a preview branch.                                          |
| [promote](https://trigger.dev/docs/cli-promote-commands)             | Promote a previously deployed version to the current version.      |
| [switch](https://trigger.dev/docs/cli-switch)                        | Switch between CLI profiles.                                       |
| [update](https://trigger.dev/docs/cli-update-commands)               | Updates all `@trigger.dev/*` packages to match the CLI version.    |

## MCP Server

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) is an open protocol that allows you to provide custom tools
to agentic LLM clients, like [Claude for Desktop](https://docs.anthropic.com/en/docs/claude-for-desktop/overview), [Cursor](https://www.cursor.com/), [Windsurf](https://windsurf.com/), etc...

The Trigger.dev CLI can expose an MCP server and enable you interact with Trigger.dev in agentic LLM workflows. For example, you can use
it to trigger tasks via natural language, view task runs, view logs, debug issues with task runs, etc...

### Starting the Trigger.dev MCP Server

To start the Trigger.dev MCP server, simply pass the `--mcp` flag to the `dev` command:

```bash
trigger dev --mcp
```

By default it runs on port `3333`. You can change this by passing the `--mcp-port` flag:

```bash
trigger dev --mcp --mcp-port 3334
```

### Configuring your MCP client

This depends on what tool you are using. For Cursor, the configuration is in the [.cursor/mcp.json](../../.cursor/mcp.json) file
and should be good to go as long as you use the default MCP server port.

Check out [Cursor's docs](https://docs.cursor.com/context/model-context-protocol) for further details.

Tip: try out [Cursor's YOLO mode](https://docs.cursor.com/context/model-context-protocol#yolo-mode) for a seamless experience :D

## Support

If you have any questions, please reach out to us on [Discord](https://trigger.dev/discord) and we'll be happy to help.
