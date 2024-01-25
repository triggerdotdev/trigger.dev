import { createJsonHeroDoc, parentTask, simplestTask, simulateError } from "./trigger/simple";

export async function main() {
  // await createJsonHeroDoc.trigger({
  //   payload: {
  //     title: "Hello World",
  //     content: {
  //       hello: "world",
  //       taskId: "create-jsonhero-doc",
  //       foo: "barrrrrrr",
  //     },
  //   },
  // });

  // return await simplestTask.trigger({ payload: { url: "https://enig6u3k3jhj.x.pipedream.net/" } });

  // await simulateError.trigger({
  //   payload: {
  //     message: "This is an error from the trigger-dev CLI",
  //   },
  // });

  await parentTask.trigger({
    payload: { message: "This is a message from the trigger-dev CLI" },
  });
}

main().then(console.log).catch(console.error);
