import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { Replicate } from "@trigger.dev/replicate";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const replicate = new Replicate({
  id: "replicate",
  apiKey: process.env["REPLICATE_API_KEY"]!,
});

client.defineJob({
  id: "replicate-forge-image",
  name: "Replicate - Forge Image",
  version: "0.1.0",
  integrations: { replicate },
  trigger: eventTrigger({
    name: "replicate.bad.forgery",
    schema: z.object({
      imageUrl: z
        .string()
        .url()
        .default("https://trigger.dev/blog/supabase-integration/postgres-meme.png"),
    }),
  }),
  run: async (payload, io, ctx) => {
    const blipVersion = "2e1dddc8621f72155f24cf2e0adbde548458d3cab9f00c0139eea840d0ac4746";
    const sdVersion = "ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4";

    const blipPrediction = await io.replicate.run("caption-image", {
      identifier: `salesforce/blip:${blipVersion}`,
      input: {
        image: payload.imageUrl,
      },
    });

    if (typeof blipPrediction.output !== "string") {
      throw new Error(`Expected string output, got ${typeof blipPrediction.output}`);
    }

    const caption = blipPrediction.output.replace("Caption: ", "");

    const sdPrediction = await io.replicate.predictions.createAndAwait("draw-image", {
      version: sdVersion,
      input: {
        prompt: caption,
      },
    });

    return {
      caption,
      output: sdPrediction.output,
    };
  },
});

client.defineJob({
  id: "replicate-python-answers",
  name: "Replicate - Python Answers",
  version: "0.1.0",
  integrations: { replicate },
  trigger: eventTrigger({
    name: "replicate.serious.monty",
    schema: z.object({
      prompt: z.string().default("why are apples not oranges?"),
    }),
  }),
  run: async (payload, io, ctx) => {
    const prediction = await io.replicate.run("await-prediction", {
      identifier:
        "meta/llama-2-13b-chat:f4e2de70d66816a838a89eeeb621910adffb0dd0baba3976c96980970978018d",
      input: {
        prompt: payload.prompt,
        system_prompt: "Answer like John Cleese. Don't be funny.",
        max_new_tokens: 200,
      },
    });

    return Array.isArray(prediction.output) ? prediction.output.join("") : prediction.output;
  },
});

client.defineJob({
  id: "replicate-cinematic-prompt",
  name: "Replicate - Cinematic Prompt",
  version: "0.1.0",
  integrations: { replicate },
  trigger: eventTrigger({
    name: "replicate.cinematic",
    schema: z.object({
      prompt: z.string().default("rick astley riding a harley through post-apocalyptic miami"),
      version: z
        .string()
        .default("af1a68a271597604546c09c64aabcd7782c114a63539a4a8d14d1eeda5630c33"),
    }),
  }),
  run: async (payload, io, ctx) => {
    const prediction = await io.replicate.predictions.createAndAwait("await-prediction", {
      version: payload.version,
      input: {
        prompt: `${payload.prompt}, cinematic, 70mm, anamorphic, bokeh`,
        width: 1280,
        height: 720,
      },
    });
    return prediction.output;
  },
});

client.defineJob({
  id: "replicate-pagination",
  name: "Replicate - Pagination",
  version: "0.1.0",
  integrations: {
    replicate,
  },
  trigger: eventTrigger({
    name: "replicate.paginate",
  }),
  run: async (payload, io, ctx) => {
    // getAll - returns an array of all results (uses paginate internally)
    const all = await io.replicate.getAll(io.replicate.predictions.list, "get-all");

    // paginate - returns an async generator, useful to process one page at a time
    for await (const predictions of io.replicate.paginate(
      io.replicate.predictions.list,
      "paginate-all"
    )) {
      await io.logger.info("stats", {
        total: predictions.length,
        versions: predictions.map((p) => p.version),
      });
    }

    return { count: all.length };
  },
});

createExpressServer(client);
