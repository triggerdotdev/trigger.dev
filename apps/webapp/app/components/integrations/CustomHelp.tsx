import { CodeBlock } from "../code/CodeBlock";
import { Header1, Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";

export function CustomHelp({ name }: { name: string }) {
  return (
    <div className="mt-4">
      <Header1 className="mb-2">You can use any API with requests or an SDK</Header1>
      <Header2 className="mb-2">How to use an SDK</Header2>
      <Paragraph spacing>
        You can call SDK methods from inside the run function, but you should wrap them in a Task to
        make sure they're resumable.
      </Paragraph>
      <Paragraph spacing>Here's an example with the official GitHub SDK</Paragraph>
      <CodeBlock
        code={`
client.defineJob({
  id: "scheduled-job-1",
  name: "Scheduled Job 1",
  version: "0.1.1",
  trigger: cronTrigger({
    cron: "*/5 * * * *", // every 5 minutes
  }),
  run: async (payload, io, ctx) => {
    //wrap an SDK call in io.runTask so it's resumable and displays in logs
    const repo = await io.runTask(
      "Get repo",
      //you can add metadata to the task to improve the display in the logs
      { name: "Get repo", icon: "github" },
      async () => {
        //this is the regular GitHub SDK
        const response = await octokit.rest.repos.get({
          owner: "triggerdotdev",
          repo: "trigger.dev",
        });
        return response.data;
      }
    );
  },
});
      `}
        highlightedRanges={[[9, 22]]}
        className="mb-4"
      />
      <Header2 className="mb-2">How to use fetch</Header2>
      <Paragraph spacing>
        You can use the fetch API to make requests to any API. Or a different request library like
        axios if you'd prefer. Again wrapping the request in a Task will make sure it's resumable.
      </Paragraph>
      <CodeBlock
        code={`
client.defineJob({
  id: "scheduled-job-1",
  name: "Scheduled Job 1",
  version: "0.1.1",
  trigger: cronTrigger({
    cron: "*/5 * * * *", // every 5 minutes
  }),
  run: async (payload, io, ctx) => {
    //wrap anything in io.runTask so it's resumable and displays in logs
    const repo = await io.runTask(
      "Get org",
      //you can add metadata to the task to improve the display in the logs
      { name: "Get org", icon: "github" },
      async () => {
        //you can use fetch, axios, or any other library to make requests
        const response = await fetch('https://api.github.com/orgs/nodejs');
        return response.json();
      }
    );
  },
});
      `}
        highlightedRanges={[[9, 19]]}
        className="mb-4"
      />
    </div>
  );
}
