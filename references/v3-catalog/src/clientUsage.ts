import { tasks } from "@trigger.dev/sdk/v3";

async function main() {
  await tasks.trigger(
    "create-jsonhero-doc",
    {
      title: "Hello World",
      content: {
        message: "Hello, World!",
      },
    },
    {
      ttl: "1m",
    }
  );

  await tasks.trigger(
    "create-jsonhero-doc",
    {
      title: "Hello World",
      content: {
        message: "Hello, World!",
      },
    },
    {
      ttl: "1m",
    }
  );
}

main().catch(console.error);
