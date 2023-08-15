import { eventTrigger, intervalTrigger } from "@trigger.dev/sdk";
import { client } from "@/trigger";

const QUOTES = [
  "Any fool can write code that a computer can understand. Good programmers write code that humans can understand. – Martin Fowler",
  "First, solve the problem. Then, write the code. – John Johnson",
  "Experience is the name everyone gives to their mistakes. – Oscar Wilde",
  "In order to be irreplaceable, one must always be different – Coco Chanel",
  "Knowledge is power. – Francis Bacon",
  "Sometimes it pays to stay in bed on Monday, rather than spending the rest of the week debugging Monday’s code. – Dan Salomon",
  "Perfection is achieved not when there is nothing more to add, but rather when there is nothing more to take away. – Antoine de Saint-Exupery",
  "Rust is the most loved programming language. – Stack Overflow",
  "Code is like humor. When you have to explain it, it’s bad. – Cory House",
  "Fix the cause, not the symptom. – Steve Maguire",
];

client.defineJob({
  id: "hello-world",
  name: "Hello World",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "starter.hello-world",
  }),
  run: async (_payload, io, _ctx) => {
    await io.logger.info("Hello world!");

    return {
      message: "Hello world!",
    };
  },
});

client.defineJob({
  id: "quote",
  name: "Random Quote",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "starter.quote",
  }),
  run: async (_payload, _io, _ctx) => {
    return {
      quote: QUOTES[Math.floor(Math.random() * QUOTES.length)],
    };
  },
});

client.defineJob({
  id: "usd-eur-change-rate",
  name: "USD-EUR Change Rate",
  version: "0.0.1",
  trigger: intervalTrigger({
    seconds: 60,
  }),
  run: async (_payload, io, _ctx) => {
    // This is just a dummy example, we can actually use an API to pull the actual rate
    await io.logger.info("Fetching USD-EUR rate...");

    return {
      rate: 0.85,
    };
  },
});

client.defineJob({
  id: "stars-count",
  name: "Number of stars for Trigger.dev repo",
  version: "0.0.1",
  trigger: intervalTrigger({
    seconds: 60 * 60,
  }),
  run: async (_payload, io, _ctx) => {
    return await io.runTask(
      "get-stars-count",
      async () => {
        try {
          const response = await fetch("https://api.github.com/repos/triggerdotdev/trigger.dev");
          const { stargazers_count } = await response.json();

          return { success: true, stargazers_count };
        } catch (error) {
          await io.logger.error("Failed to fetch stars count", { error });

          return { success: false };
        }
      }, 
      { name: "Get Trigger.dev stars count" }
    );
  },
});
