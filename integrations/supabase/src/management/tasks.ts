import { AuthenticatedTask } from "@trigger.dev/sdk";
import {
  GetProjectsResponseData,
  RunQueryResponseData,
  SupabaseManagementAPI,
} from "./client";

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

export const runQuery: AuthenticatedTask<
  SupabaseManagementAPI,
  { ref: string; query: string },
  RunQueryResponseData
> = {
  run: async (params, client) => {
    return client.queryProject(params.ref, params.query);
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
