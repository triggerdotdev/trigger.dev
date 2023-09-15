import { IntegrationTaskKey } from "@trigger.dev/sdk";
import {
  GetAllResponsesParams,
  GetAllResponsesResponse,
  ListResponsesParams,
  ListResponsesResponse,
  TypeformRunTask,
} from ".";

export class Responses {
  runTask: TypeformRunTask;

  constructor(runTask: TypeformRunTask) {
    this.runTask = runTask;
  }

  list(key: IntegrationTaskKey, params: ListResponsesParams): Promise<ListResponsesResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.responses.list(params);
      },
      {
        name: "List Responses",
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

  all(key: IntegrationTaskKey, params: GetAllResponsesParams): Promise<GetAllResponsesResponse> {
    const pageSize = 50;

    const listResponsesForPage = (before?: string) => {
      const pageParams = {
        ...params,
        submitted_at: "desc",
        before,
        pageSize: pageSize,
      };

      return this.list(`page${before ? `-before-${before}` : ""}`, pageParams);
    };

    return this.runTask(
      key,
      async (client, task) => {
        // We're going to create a subtask for each page of responses
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
      {
        name: "Get All Responses",
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
