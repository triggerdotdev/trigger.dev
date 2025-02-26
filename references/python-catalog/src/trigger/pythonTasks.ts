import { schemaTask, task } from "@trigger.dev/sdk/v3";
import { python } from "@trigger.dev/python";
import { z } from "zod";

export const convertUrlToMarkdown = schemaTask({
  id: "convert-url-to-markdown",
  schema: z.object({
    url: z.string().url(),
  }),
  run: async (payload) => {
    const result = await python.runScript("./src/python/html2text_url.py", [payload.url]);

    return result.stdout;
  },
});

export const pythonRunInlineTask = task({
  id: "python-run-inline",
  run: async () => {
    const result = await python.runInline(`
import html2text as h2t

h = h2t.HTML2Text()

print(h.handle("<p>Hello, <a href='https://www.google.com/earth/'>world</a>!"))
`);
    return result.stdout;
  },
});
