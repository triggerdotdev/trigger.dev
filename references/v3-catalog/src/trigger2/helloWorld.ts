import { task } from "@trigger.dev/sdk/v3";

const helloWorld = task({
  id: "helloWorld",
  async run() {
    console.log("Hello World!");
  },
});
