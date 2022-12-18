```ts
import { Trigger } from "@trigger.dev/sdk";
import { github, slack } from "@trigger.dev/integrations";

new Trigger({
  on: github.onNewStar({ repo: "apihero-run/jsonhero-web" }),
  lib: { slack },
  run: (event, lib) => {
    await lib.slack.send({
      channel: "jsonhero-stars",
      text: `You got a new star from ${event.username}`,
    });
  },
});
```
