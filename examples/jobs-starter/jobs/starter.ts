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
  "Ruby is rubbish! PHP is phpantastic! – Nikita Popov",
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
  id: "change-rate",
  name: "USD-EUR Change Rate",
  version: "0.0.1",
  trigger: intervalTrigger({
    name: "starter.change-rate",
    seconds: 60,
  }),
  run: async (payload, io, _ctx) => {
    const { amount } = payload;

    await io.logger.log(`Amount: ${amount} USD`);

    // This is just a dummy example, we can use an API to pull the actual rate

    return {
      rate: 0.85,
      amount: amount * 0.85,
    };
  },
});
