import { truncate } from "@trigger.dev/integration-kit";
import { IntegrationTaskKey, Prettify } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { createTaskUsageProperties } from "./taskUtils";

export class Edits {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  /**
   * @deprecated The Edits API is deprecated; please use Chat Completions instead.
   */
  create(key: IntegrationTaskKey, params: Prettify<OpenAI.EditCreateParams>): Promise<OpenAI.Edit> {
    let properties = [
      {
        label: "Model",
        text: params.model,
      },
    ];

    if (params.input) {
      properties.push({
        label: "Input",
        text: truncate(params.input, 40),
      });
    }

    properties.push({
      label: "Instruction",
      text: truncate(params.instruction, 40),
    });

    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.edits.create(params);
        task.outputProperties = createTaskUsageProperties(response.usage);
        return response;
      },
      {
        name: "Create edit",
        params,
        properties,
      }
    );
  }
}
