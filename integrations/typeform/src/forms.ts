import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { GetFormParams, GetFormResponse, ListFormsParams, TypeformRunTask } from ".";
import { Typeform } from "@typeform/api-client";

export class Forms {
  constructor(private runTask: TypeformRunTask) {}

  list(key: IntegrationTaskKey, params: ListFormsParams): Promise<Typeform.API.Forms.List> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.forms.list(params ?? {});
      },
      {
        name: "List Forms",
        params,
        properties: [
          ...(params?.workspaceId ? [{ label: "Workspace ID", text: params.workspaceId }] : []),
          ...(params?.search ? [{ label: "Search", text: params.search }] : []),
          ...(params?.page ? [{ label: "Page", text: String(params.page) }] : []),
          ...(params?.pageSize ? [{ label: "Page Size", text: String(params.pageSize) }] : []),
        ],
      }
    );
  }

  get(key: IntegrationTaskKey, params: GetFormParams): Promise<GetFormResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.forms.get(params);
      },
      {
        name: "Get Form",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
        ],
      }
    );
  }
}
