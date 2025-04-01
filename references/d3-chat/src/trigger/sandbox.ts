import { openai } from "@ai-sdk/openai";
import { Sandbox } from "@e2b/code-interpreter";
import { ai } from "@trigger.dev/sdk/ai";
import { schemaTask } from "@trigger.dev/sdk/v3";
import { generateObject } from "ai";
import { z } from "zod";

const chartTask = schemaTask({
  id: "chart",
  description: "Generate a chart using natural language",
  schema: z.object({
    input: z.string().describe("The chart to generate"),
  }),
  run: async ({ input }) => {
    const code = await generateObject({
      model: openai("gpt-4o"),
      schema: z.object({
        code: z.string().describe("The Python code to execute"),
      }),
      system: `
        You are a helpful assistant that can generate Python code to be executed in a sandbox, using matplotlib.pyplot.

        For example: 
        
        import matplotlib.pyplot as plt
        plt.plot([1, 2, 3, 4])
        plt.ylabel('some numbers')
        plt.show()
        
        Make sure the code ends with plt.show()
      `,
      prompt: input,
    });

    const sandbox = await Sandbox.create();

    const execution = await sandbox.runCode(code.object.code);

    const firstResult = execution.results[0];

    if (firstResult.png) {
      return {
        chart: firstResult.png,
      };
    } else {
      throw new Error("No chart generated");
    }
  },
});

export const chartTool = ai.tool(chartTask, {
  experimental_toToolResultContent: (result) => {
    return [
      {
        type: "image",
        data: result.chart,
        mimeType: "image/png",
      },
    ];
  },
});
