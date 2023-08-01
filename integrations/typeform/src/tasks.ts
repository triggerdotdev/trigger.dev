import type { AuthenticatedTask } from "@trigger.dev/sdk";
import { Typeform } from "@typeform/api-client";
import type {
  CreateWebhookParams,
  DeleteWebhookParams,
  DeleteWebhookResponse,
  GetAllResponsesParams,
  GetAllResponsesResponse,
  GetFormParams,
  GetFormResponse,
  GetWebhookParams,
  GetWebhookResponse,
  ListFormsParams,
  ListResponsesParams,
  ListResponsesResponse,
  ListWebhooksParams,
  ListWebhooksResponse,
  TypeformSDK,
  UpdateWebhookParams,
} from "./types";

export const listForms: AuthenticatedTask<TypeformSDK, ListFormsParams, Typeform.API.Forms.List> = {
  run: async (params, client) => {
    return client.forms.list(params ?? {});
  },
  init: (params) => {
    return {
      name: "List Forms",
      params,
      icon: "typeform",
      properties: [
        ...(params?.workspaceId ? [{ label: "Workspace ID", text: params.workspaceId }] : []),
        ...(params?.search ? [{ label: "Search", text: params.search }] : []),
        ...(params?.page ? [{ label: "Page", text: String(params.page) }] : []),
        ...(params?.pageSize ? [{ label: "Page Size", text: String(params.pageSize) }] : []),
      ],
    };
  },
};

export const getForm: AuthenticatedTask<TypeformSDK, GetFormParams, GetFormResponse> = {
  run: async (params, client) => {
    return client.forms.get(params);
  },
  init: (params) => {
    return {
      name: "Get Form",
      params,
      icon: "typeform",
      properties: [
        {
          label: "Form ID",
          text: params.uid,
        },
      ],
    };
  },
};

export const listResponses: AuthenticatedTask<
  TypeformSDK,
  ListResponsesParams,
  ListResponsesResponse
> = {
  run: async (params, client) => {
    return client.responses.list(params);
  },
  init: (params) => {
    return {
      name: "List Responses",
      params,
      icon: "typeform",
      properties: [
        {
          label: "Form ID",
          text: params.uid,
        },
      ],
    };
  },
};

export const getAllResponses: AuthenticatedTask<
  TypeformSDK,
  GetAllResponsesParams,
  GetAllResponsesResponse
> = {
  run: async (params, client, task, io, auth) => {
    // We're going to create a subtask for each page of responses

    const pageSize = 50;

    async function listResponsesForPage(before?: string) {
      const pageParams = {
        ...params,
        submitted_at: "desc",
        before,
        pageSize: pageSize,
      };
      // @ts-ignore
      // This is needed because of the index signature on the response type
      return io.runTask<ListResponsesResponse>(
        `page${before ? `-before-${before}` : ""}`,
        listResponses.init(pageParams),
        async (t, io) => {
          return await listResponses.run(pageParams, client, t, io, auth);
        }
      );
    }

    const firstPage = await listResponsesForPage();
    let token = firstPage.items[firstPage.items.length - 1].token;

    const totalPages = Math.ceil(firstPage.total_items / pageSize);
    const allResponses = firstPage.items;

    for (let i = 1; i < totalPages; i++) {
      const page = await listResponsesForPage(token);
      token = page.items[page.items.length - 1].token;
      allResponses.push(...page.items);
    }

    return allResponses;
  },
  init: (params) => {
    return {
      name: "Get All Responses",
      params,
      icon: "typeform",
      properties: [
        {
          label: "Form ID",
          text: params.uid,
        },
      ],
    };
  },
};

export const createWebhook: AuthenticatedTask<
  TypeformSDK,
  CreateWebhookParams,
  GetWebhookResponse
> = {
  run: async (params, client) => {
    return client.webhooks.create(params);
  },
  init: (params) => {
    return {
      name: "Create Webhook",
      params,
      icon: "typeform",
      properties: [
        {
          label: "Form ID",
          text: params.uid,
        },
        {
          label: "Tag",
          text: params.tag,
        },
      ],
    };
  },
};

export const listWebhooks: AuthenticatedTask<
  TypeformSDK,
  ListWebhooksParams,
  ListWebhooksResponse
> = {
  run: async (params, client) => {
    return client.webhooks.list(params);
  },
  init: (params) => {
    return {
      name: "List Webhooks",
      params,
      icon: "typeform",
      properties: [
        {
          label: "Form ID",
          text: params.uid,
        },
      ],
    };
  },
};

export const updateWebhook: AuthenticatedTask<
  TypeformSDK,
  UpdateWebhookParams,
  GetWebhookResponse
> = {
  run: async (params, client) => {
    return client.webhooks.update(params);
  },
  init: (params) => {
    return {
      name: "Update Webhook",
      params,
      icon: "typeform",
      properties: [
        {
          label: "Form ID",
          text: params.uid,
        },
        {
          label: "Tag",
          text: params.tag,
        },
      ],
    };
  },
};

export const getWebhook: AuthenticatedTask<TypeformSDK, GetWebhookParams, GetWebhookResponse> = {
  run: async (params, client) => {
    return client.webhooks.get(params);
  },
  init: (params) => {
    return {
      name: "Get Webhook",
      params,
      icon: "typeform",
      properties: [
        {
          label: "Form ID",
          text: params.uid,
        },
        {
          label: "Tag",
          text: params.tag,
        },
      ],
    };
  },
};

export const deleteWebhook: AuthenticatedTask<
  TypeformSDK,
  DeleteWebhookParams,
  DeleteWebhookResponse
> = {
  run: async (params, client) => {
    return client.webhooks.delete(params);
  },
  init: (params) => {
    return {
      name: "Delete Webhook",
      params,
      icon: "typeform",
      properties: [
        {
          label: "Form ID",
          text: params.uid,
        },
        {
          label: "Tag",
          text: params.tag,
        },
      ],
    };
  },
};
