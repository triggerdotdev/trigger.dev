## trigger.dev claude-code-agent rules file

Create tasks like this:

```ts
import { task } from "@trigger.dev/sdk";

export const onePager = task({
  id: "one-pager",
  run: async (ctx) => {
    const { data } = ctx;
  },
});
```
