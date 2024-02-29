import { CodeBlock } from "~/components/code/CodeBlock";

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-8 p-8">
      <CodeBlock
        code={`{ id: "my-first-job" }`}
        highlightedRanges={[
          [6, 8],
          [12, 14],
        ]}
      />
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
