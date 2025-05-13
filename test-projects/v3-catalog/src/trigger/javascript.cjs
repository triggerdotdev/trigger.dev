const { task } = require("@trigger.dev/sdk/v3");

const myJavascriptTask = task({
  id: "my-javascript-task",
  run: async (payload) => {
    console.log("Hello from JavaScript task!");
  },
});

module.exports = { myJavascriptTask };
