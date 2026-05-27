import { VERSION } from "../version.js";

export const serverMetadata = {
  name: "trigger",
  version: VERSION,
  instructions: `Trigger.dev MCP server to automate your Trigger.dev projects and answer questions about Trigger.dev by searching the docs. 
If you need help setting up Trigger.dev in your project please refer to https://trigger.dev/docs/manual-setup. 
If the user asks for help with adding Trigger.dev to their project, please refer to https://trigger.dev/docs/manual-setup.
  `,
};

export const toolsMetadata = {
  search_docs: {
    name: "search_docs",
    title: "Search Docs",
    description:
      "Search across the Trigger.dev documentation to find relevant information, code examples, API references, and guides. Use this tool when you need to answer questions about Trigger.dev, find specific documentation, understand how features work, or locate implementation details. The search returns contextual content with titles and direct links to the documentation pages",
  },
  list_projects: {
    name: "list_projects",
    title: "List Projects",
    description:
      "List all projects for the current user, useful for when searching for a project and for looking up a projectRef",
  },
  list_orgs: {
    name: "list_orgs",
    title: "List Organizations",
    description:
      "List all organizations for the current user. Useful when looking up an org slug or ID.",
  },
  create_project_in_org: {
    name: "create_project_in_org",
    title: "Create Project in Organization",
    description:
      "Create a new project in an organization. Only do this if the user wants to add Trigger.dev to an existing project. If there is already a trigger.config.ts file present, then you should not create a new project.",
  },
  initialize_project: {
    name: "initialize_project",
    title: "Initialize Project",
    description:
      "Initialize Trigger.dev in your project. This will create a new project in the organization you select and add Trigger.dev to your project.",
  },
  get_tasks: {
    name: "get_tasks",
    title: "Get Tasks",
    description:
      "Get all tasks in the project. Useful when searching for a task and for looking up a task identifier/slug",
  },
  get_current_worker: {
    name: "get_current_worker",
    title: "Get Current Worker",
    description:
      "Get the current worker for the project, including version and registered task slugs. Use get_task_schema to get the payload schema for a specific task.",
  },
  get_task_schema: {
    name: "get_task_schema",
    title: "Get Task Schema",
    description:
      "Get the payload schema for a specific task. Use get_current_worker first to see available task slugs.",
  },
  trigger_task: {
    name: "trigger_task",
    title: "Trigger Task",
    description:
      "Trigger a task in the project. Use the get_tasks tool to get a list of tasks and ask the user to select one if it's not clear which one to use. Use the wait_for_run_to_complete tool to wait for the run to complete.",
  },
  get_run_details: {
    name: "get_run_details",
    title: "Get Run Details",
    description:
      "Get the details and trace of a run. Trace events are paginated — the first call returns run details and the first page of trace lines. Pass the returned cursor to fetch subsequent pages without re-fetching the trace. The run ID starts with run_.",
  },
  get_span_details: {
    name: "get_span_details",
    title: "Get Span Details",
    description:
      "Get detailed information about a specific span within a run trace. Use get_run_details first to see the trace and find span IDs (shown as [spanId] in the trace output). Returns timing, properties/attributes, error info, and for AI spans: model, tokens, cost, and response data.",
  },
  wait_for_run_to_complete: {
    name: "wait_for_run_to_complete",
    title: "Wait for Run to Complete",
    description:
      "Wait for a run to complete. The run ID is the ID of the run that was triggered. It starts with run_. Has an optional timeoutInSeconds parameter (default 60s) - if the run doesn't complete within that time, the current state of the run will be returned.",
  },
  cancel_run: {
    name: "cancel_run",
    title: "Cancel Run",
    description:
      "Cancel a run. The run ID is the ID of the run that was triggered. It starts with run_",
  },
  list_runs: {
    name: "list_runs",
    title: "List Runs",
    description:
      "List all runs for a project. Use this tool when you need to search for a run or list all runs for a project.",
  },
  deploy: {
    name: "deploy",
    title: "Deploy",
    description:
      "Deploy a project. Use this tool when you need to deploy a project. This will trigger a deployment for the project. This is a long running operation and including a progress token will allow you to display the progress to the user.",
  },
  list_deploys: {
    name: "list_deploys",
    title: "List Deploys",
    description:
      "List all deploys for a project. Use this tool when you need to search for a deploy or list all deploys for a project.",
  },
  list_preview_branches: {
    name: "list_preview_branches",
    title: "List Preview Branches",
    description:
      "List all preview branches for a project. Use this tool when you need to search for a preview branch or list all preview branches for a project.",
  },
  query: {
    name: "query",
    title: "Query",
    description:
      "Execute a TRQL query against your Trigger.dev data. TRQL is a SQL-style query language for analyzing runs, metrics, and LLM usage. Call the get_query_schema tool first to discover available tables and columns before writing a query.",
  },
  get_query_schema: {
    name: "get_query_schema",
    title: "Get Query Schema",
    description:
      "Get the column schema for a specific TRQL table. Available tables: 'runs' (task execution data), 'metrics' (CPU, memory, custom metrics), 'llm_metrics' (LLM token usage, costs, latency). Returns columns, types, descriptions, and allowed values for the specified table.",
  },
  list_dashboards: {
    name: "list_dashboards",
    title: "List Dashboards",
    description:
      "List available built-in dashboards with their widgets. Each dashboard contains pre-built queries for common metrics like run success rates, costs, LLM usage, and more. Use run_dashboard to execute a dashboard's queries.",
  },
  run_dashboard_query: {
    name: "run_dashboard_query",
    title: "Run Dashboard Query",
    description:
      "Execute a single widget query from a built-in dashboard. Use list_dashboards first to see available dashboards, widget IDs, and their queries. Supports time period and scope options.",
  },
  whoami: {
    name: "whoami",
    title: "Who Am I",
    description:
      "Show the current authenticated user, active CLI profile, email, and API URL.",
  },
  list_profiles: {
    name: "list_profiles",
    title: "List Profiles",
    description:
      "List all configured CLI profiles. Shows which profile is currently active.",
  },
  switch_profile: {
    name: "switch_profile",
    title: "Switch Profile",
    description:
      "Switch the active CLI profile for this MCP session. This changes which Trigger.dev account and API URL are used for all subsequent tool calls.",
  },
  start_dev_server: {
    name: "start_dev_server",
    title: "Start Dev Server",
    description:
      "Start the Trigger.dev dev server (`trigger dev`) in the background. Waits up to 30 seconds for the worker to be ready. Use `dev_server_status` to check output and `stop_dev_server` to stop it.",
  },
  stop_dev_server: {
    name: "stop_dev_server",
    title: "Stop Dev Server",
    description: "Stop the running Trigger.dev dev server.",
  },
  dev_server_status: {
    name: "dev_server_status",
    title: "Dev Server Status",
    description:
      "Check the status of the dev server and view recent output. Shows whether it is stopped, starting, ready, or has errors, along with recent log lines.",
  },
  list_prompts: {
    name: "list_prompts",
    title: "List Prompts",
    description:
      "List all managed prompts in the project environment. Shows slug, current version, override status, and version count.",
  },
  get_prompt_versions: {
    name: "get_prompt_versions",
    title: "Get Prompt Versions",
    description:
      "List all versions for a specific prompt. Shows version number, labels (current, override, latest), source (code or dashboard), model, and content.",
  },
  promote_prompt_version: {
    name: "promote_prompt_version",
    title: "Promote Prompt Version",
    description:
      "Promote a prompt version to be the current active version. Only code-sourced versions can be promoted — dashboard overrides must use the override tools instead.",
  },
  create_prompt_override: {
    name: "create_prompt_override",
    title: "Create Prompt Override",
    description:
      "Create a dashboard override for a prompt. The override takes precedence over the current code version when resolving the prompt. Provide the full text content for the override.",
  },
  update_prompt_override: {
    name: "update_prompt_override",
    title: "Update Prompt Override",
    description:
      "Update the active dashboard override for a prompt. Only works if an override is currently active.",
  },
  remove_prompt_override: {
    name: "remove_prompt_override",
    title: "Remove Prompt Override",
    description:
      "Remove the active dashboard override for a prompt, reverting to the current code version.",
  },
  reactivate_prompt_override: {
    name: "reactivate_prompt_override",
    title: "Reactivate Prompt Override",
    description:
      "Reactivate a previous dashboard-sourced version as the active override. Use get_prompt_versions to find dashboard versions that can be reactivated.",
  },
  list_agents: {
    name: "list_agents",
    title: "List Agents",
    description:
      "List all chat agents in the current worker. Agents are tasks created with chat.agent() or chat.customAgent(). Use start_agent_chat with an agent's slug to start a conversation.",
  },
  start_agent_chat: {
    name: "start_agent_chat",
    title: "Start Agent Chat",
    description:
      "Start a conversation with a chat agent. Returns a chatId you can use with send_agent_message. Optionally preloads the agent so it initializes before the first message.",
  },
  send_agent_message: {
    name: "send_agent_message",
    title: "Send Agent Message",
    description:
      "Send a message to an active agent chat and get the full response text back. Use the chatId from start_agent_chat. The agent remembers full context from previous messages in the same chat.",
  },
  close_agent_chat: {
    name: "close_agent_chat",
    title: "Close Agent Chat",
    description:
      "Close an agent chat conversation. The agent exits its loop gracefully. Without this, the agent will close on its own when its idle timeout expires.",
  },
};
