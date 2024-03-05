import { CodeBlock } from "~/components/code/CodeBlock";
import { Header2 } from "~/components/primitives/Headers";

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-8 p-8">
      <Header2>Inline field</Header2>
      <CodeBlock code={`{ id: "my-first-job" }`} />
      <Header2>With title row</Header2>
      <CodeBlock
        showTitleRow
        rowTitle="Trigger client"
        code={`export const client = new TriggerClient("smoke-test", {
          apiUrl: "http://localhost:3000",
          endpoint: "http://localhost:3007/__trigger/entry",
          logLevel: "debug",
          longLine: "This is a long line that will scroll off the edge of the screen and cause a horizontal scrollbar",
          onLog: (log) => {
            console.log(log);
          },
          onLogError: (log) => {
            console.error(log);
          },
          onLogWarning: (log) => {
            console.warn(log);
          },
          onLogInfo: (log) => {
            console.info(log);
          },
        });`}
      />
      <Header2>showChrome</Header2>
      <CodeBlock
        showChrome
        fileName="trigger-client.ts"
        code={`export const client = new TriggerClient("smoke-test", {
          apiUrl: "http://localhost:3000",
          endpoint: "http://localhost:3007/__trigger/entry",
          logLevel: "debug",
          longLine: "This is a long line that will scroll off the edge of the screen and cause a horizontal scrollbar",
          onLog: (log) => {
            console.log(log);
          },
          onLogError: (log) => {
            console.error(log);
          },
          onLogWarning: (log) => {
            console.warn(log);
          },
          onLogInfo: (log) => {
            console.info(log);
          },
        });`}
      />
      <Header2>Inline copy button</Header2>
      <CodeBlock
        code={`export const client = new TriggerClient("smoke-test", {
          apiUrl: "http://localhost:3000",
          endpoint: "http://localhost:3007/__trigger/entry",
          logLevel: "debug",
          longLine: "This is a long line that will scroll off the edge of the screen and cause a horizontal scrollbar",
          onLog: (log) => {
            console.log(log);
          },
          onLogError: (log) => {
            console.error(log);
          },
          onLogWarning: (log) => {
            console.warn(log);
          },
          onLogInfo: (log) => {
            console.info(log);
          },
        });`}
      />
      <Header2>Highlighted range</Header2>
      <CodeBlock
        code={`export const client = new TriggerClient("smoke-test", {
          apiUrl: "http://localhost:3000",
          endpoint: "http://localhost:3007/__trigger/entry",
          logLevel: "debug",
          longLine: "This is a long line that will scroll off the edge of the screen and cause a horizontal scrollbar",
          onLog: (log) => {
            console.log(log);
          },
          onLogError: (log) => {
            console.error(log);
          },
          onLogWarning: (log) => {
            console.warn(log);
          },
          onLogInfo: (log) => {
            console.info(log);
          },
        });`}
        highlightedRanges={[
          [6, 8],
          [12, 14],
        ]}
      />
    </div>
  );
}
