import { client } from "@/trigger";
import { eventTrigger } from "@trigger.dev/sdk";

client.defineJob({
  id: "hooks-test-job",
  name: "Hooks test job",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "test-event",
  }),
  run: async (payload, io, ctx) => {
    const gettingInputData = await io.createStatus("getting-input-data", {
      label: "Getting input data",
      // state: "loading",
    });

    await io.wait("wait-input", 2);

    await gettingInputData.update("input-data-complete", {
      label: "Input data complete",
      state: "success",
    });

    const generatingMemes = await io.createStatus("generating-memes", {
      label: "Generating memes",
      state: "loading",
      data: {
        progress: 0.1,
      },
    });

    await io.wait("wait", 2);

    //...do stuff
    await generatingMemes.update("middle-generation", {
      data: {
        progress: 0.3,
        urls: [
          "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZnZoMndsdWh0MmhvY2kyaDF6YjZjZzg1ZGsxdnhhYm13a3Q1Y3lkbyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/13HgwGsXF0aiGY/giphy.gif",
        ],
      },
    });

    await io.wait("wait-again", 4);

    //...do stuff
    await generatingMemes.update("generating-more-memes", {
      data: {
        progress: 0.6,
        urls: [
          "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZnZoMndsdWh0MmhvY2kyaDF6YjZjZzg1ZGsxdnhhYm13a3Q1Y3lkbyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/13HgwGsXF0aiGY/giphy.gif",
          "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbXdhNGhjaXVoZzFrMWJ0dmYyM2ZuOTIxN2J3aWYwY3J1OHI4eW13cCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/scZPhLqaVOM1qG4lT9/giphy.gif",
        ],
      },
    });

    await io.wait("wait-again", 4);

    await generatingMemes.update("completed-generation", {
      label: "Generated memes",
      state: "success",
      data: {
        progress: 1.0,
        urls: [
          "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZnZoMndsdWh0MmhvY2kyaDF6YjZjZzg1ZGsxdnhhYm13a3Q1Y3lkbyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/13HgwGsXF0aiGY/giphy.gif",
          "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbXdhNGhjaXVoZzFrMWJ0dmYyM2ZuOTIxN2J3aWYwY3J1OHI4eW13cCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/scZPhLqaVOM1qG4lT9/giphy.gif",
          "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdHJhdXJ2Nnl6YnR3bXZuejZ3Y3Q5a2w3Mng2ZXZmMmJjeWdtZWhibCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/yYSSBtDgbbRzq/giphy-downsized.gif",
        ],
      },
    });
  },
});
