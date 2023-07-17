import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { SupabaseManagementAPI } from "./management/client";
import * as tasks from "./management/tasks";

export type SupabaseManagementIntegrationOptions = {
  id: string;
};

export class SupabaseManagement
  implements
    TriggerIntegration<IntegrationClient<SupabaseManagementAPI, typeof tasks>>
{
  client: IntegrationClient<any, typeof tasks>;

  constructor(private options: SupabaseManagementIntegrationOptions) {
    this.client = {
      tasks,
      usesLocalAuth: false,
      clientFactory: (auth) => {
        return new SupabaseManagementAPI({ accessToken: auth.accessToken });
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "supabase-management", name: "Supabase Management API" };
  }
}
