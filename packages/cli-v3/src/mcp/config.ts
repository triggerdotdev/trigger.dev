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
  trigger_task: {
    name: "trigger_task",
    title: "Trigger Task",
    description:
      "Trigger a task in the project. Use the get_tasks tool to get a list of tasks and ask the user to select one if it's not clear which one to use.",
  },
  get_run_details: {
    name: "get_run_details",
    title: "Get Run Details",
    description:
      "Get the details of a run. The run ID is the ID of the run that was triggered. It starts with run_",
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
      "Deploy a project. Use this tool when you need to deploy a project. This will trigger a deployment for the project.",
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
};
