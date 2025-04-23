import { logger, schemaTask, task } from "@trigger.dev/sdk/v3";
import { python } from "@trigger.dev/python";
import { z } from "zod";

export const convertUrlToMarkdown = schemaTask({
  id: "convert-url-to-markdown",
  schema: z.object({
    url: z.string().url(),
  }),
  run: async (payload) => {
    const result = await python.runScript("./src/python/html2text_url.py", [payload.url]);

    logger.debug("convert-url-to-markdown", {
      url: payload.url,
      output: result.stdout,
    });

    const streamingResult = python.stream.runScript("./src/python/html2text_url.py", [payload.url]);

    for await (const chunk of streamingResult) {
      logger.debug("convert-url-to-markdown", {
        url: payload.url,
        chunk,
      });
    }
  },
});

export const pythonRunInlineTask = task({
  id: "python-run-inline",
  run: async () => {
    const result = await python.runInline(
      `
import os
import html2text as h2t

h = h2t.HTML2Text()

print(h.handle("<p>Hello, <a href='https://www.google.com/earth/'>world</a>!"))
print(f"API Key: {os.environ['OPENAI_API_KEY']}")
`,
      {
        env: {
          OPENAI_API_KEY: "sk-1234567890",
        },
      }
    );

    console.log(result.stdout);

    const streamingResult = python.stream.runInline(`
import html2text as h2t

h = h2t.HTML2Text()

print(h.handle("<p>Hello, <a href='https://www.google.com/earth/'>world</a>!"))
print(h.handle("<p>Hello, <a href='https://www.google.com/earth/'>world</a>!"))
`);

    for await (const chunk of streamingResult) {
      logger.debug("python-run-inline", {
        chunk,
      });
    }

    return result.stdout;
  },
});
