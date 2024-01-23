import { createJsonHeroDoc, simplestTask } from "./trigger/simple";

export async function main() {
  await createJsonHeroDoc.trigger({
    payload: {
      title: "Hello World",
      content: {
        hello: "world",
        taskId: "create-jsonhero-doc",
        foo: "barrrrrrr",
      },
    },
  });

  // return await simplestTask.trigger({ payload: { url: "https://enig6u3k3jhj.x.pipedream.net/" } });
}

main().then(console.log).catch(console.error);
