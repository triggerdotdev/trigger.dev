import { AuthenticatedTask } from "@trigger.dev/sdk";
import type {
  CreateProjectRequestBody,
  CreateProjectResponseData,
  GetOrganizationsResponseData,
  GetPostgRESTConfigResponseData,
  GetProjectPGConfigResponseData,
  GetProjectsResponseData,
  GetTypescriptTypesResponseData,
  ListFunctionsResponseData,
  RunQueryResponseData,
  SupabaseManagementAPI,
} from "supabase-management-js";

export const getOrganizations: AuthenticatedTask<
  SupabaseManagementAPI,
  void,
  GetOrganizationsResponseData
> = {
  run: async (params, client) => {
    return client.getOrganizations();
  },
  init: (params) => {
    return {
      name: "Get Organizations",
      params,
      icon: "supabase",
    };
  },
};

export const getProjects: AuthenticatedTask<
  SupabaseManagementAPI,
  void,
  GetProjectsResponseData
> = {
  run: async (params, client) => {
    return client.getProjects();
  },
  init: (params) => {
    return {
      name: "Get Projects",
      params,
      icon: "supabase",
    };
  },
};

export const createProject: AuthenticatedTask<
  SupabaseManagementAPI,
  CreateProjectRequestBody,
  CreateProjectResponseData
> = {
  run: async (params, client) => {
    return client.createProject(params);
  },
  init: (params) => {
    return {
      name: "Create Project",
      params,
      icon: "supabase",
      properties: [
        { label: "Name", text: params.name },
        { label: "Org", text: params.organization_id },
        { label: "Region", text: params.region },
        { label: "Plan", text: params.plan },
      ],
    };
  },
};

export const listFunctions: AuthenticatedTask<
  SupabaseManagementAPI,
  { ref: string },
  ListFunctionsResponseData
> = {
  run: async (params, client) => {
    return client.listFunctions(params.ref);
  },
  init: (params) => {
    return {
      name: "List Functions",
      params,
      icon: "supabase",
      properties: [
        {
          label: "Project",
          text: params.ref,
        },
      ],
    };
  },
};

export const runQuery: AuthenticatedTask<
  SupabaseManagementAPI,
  { ref: string; query: string },
  RunQueryResponseData
> = {
  run: async (params, client) => {
    return client.runQuery(params.ref, params.query);
  },
  init: (params) => {
    return {
      name: "Run Query",
      params,
      icon: "supabase",
      properties: [
        {
          label: "Project",
          text: params.ref,
        },
      ],
    };
  },
};

export const getTypescriptTypes: AuthenticatedTask<
  SupabaseManagementAPI,
  { ref: string },
  GetTypescriptTypesResponseData
> = {
  run: async (params, client) => {
    return client.getTypescriptTypes(params.ref);
  },
  init: (params) => {
    return {
      name: "Get Typescript Types",
      params,
      icon: "supabase",
      properties: [
        {
          label: "Project",
          text: params.ref,
        },
      ],
    };
  },
};

export const getPostgRESTConfig: AuthenticatedTask<
  SupabaseManagementAPI,
  { ref: string },
  GetPostgRESTConfigResponseData
> = {
  run: async (params, client) => {
    return client.getPostgRESTConfig(params.ref);
  },
  init: (params) => {
    return {
      name: "Get PostgREST Config",
      params,
      icon: "supabase",
      properties: [
        {
          label: "Project",
          text: params.ref,
        },
      ],
    };
  },
};

/** Gets project's Postgres config */
export const getPGConfig: AuthenticatedTask<
  SupabaseManagementAPI,
  { ref: string },
  GetProjectPGConfigResponseData
> = {
  run: async (params, client) => {
    return client.getPGConfig(params.ref);
  },
  init: (params) => {
    return {
      name: "Get PG Config",
      params,
      icon: "supabase",
      properties: [
        {
          label: "Project",
          text: params.ref,
        },
      ],
    };
  },
};
