import { useState } from "react";
import { CodeExample } from "~/routes/resources.codeexample";
import { Api, ApiExample, apisList } from "~/services/externalApis/apis.server";
import { cn } from "~/utils/cn";
import { Header1, Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { TextLink } from "../primitives/TextLink";

export function CustomHelp({ api }: { api: Api }) {
  const [selectedExample, setSelectedExample] = useState(api.examples?.[0]);

  const changeCodeExample = (example: ApiExample) => {
    setSelectedExample(example);
  };

  return (
    <div className="mt-4">
      <Header1 className="mb-2">You can use any API with requests or an SDK</Header1>
      <Paragraph spacing>
        You can use Trigger.dev with any existing Node SDK or even just using fetch. You can
        subscribe to any API with{" "}
        <TextLink href="https://trigger.dev/docs/documentation/concepts/http-endpoints">
          HTTP endpoints
        </TextLink>{" "}
        and perform actions by wrapping tasks using{" "}
        <TextLink
          href="https://trigger.dev/docs/documentation/guides/writing-jobs-step-by-step#create-your-own-tasks"
          className="font-mono"
        >
          io.runTask
        </TextLink>
        . This makes your background job resumable and appear in our dashboard.
      </Paragraph>

      {api.examples && api.examples.length > 0 && (
        <>
          <Header2 className="mb-2">Example code</Header2>
          <Paragraph spacing>
            This is how you can use {api.name} with Trigger.dev. This code can be copied and
            modified to suit your use-case.
          </Paragraph>
          <div className=" flex w-full flex-row gap-4 overflow-x-scroll	scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700 sm:h-full">
            {api.examples.length > 1 &&
              api.examples?.map((example, index) => (
                <button
                  onClick={() => changeCodeExample(example)}
                  key={example.codeUrl}
                  className={cn(
                    "w-64 min-w-[16rem] p-4 transition-colors duration-300 sm:w-full sm:rounded",
                    "border-px border border-slate-900 bg-slate-900 text-slate-300 transition duration-300 hover:bg-slate-800"
                  )}
                >
                  {example.title}
                </button>
              ))}
          </div>
          {selectedExample && <CodeExample example={selectedExample} />}
        </>
      )}

      {!api.examples && (
        <>
          {/* <Header2 className="mb-2">Example code</Header2>
          <Paragraph spacing>
            We are currently working on {api.name} examples with Trigger.dev. However, here are some
            other code examples for you to look at to get an idea of how Trigger.dev works with
            other APIs.
          </Paragraph>
          <div className=" flex w-full flex-row gap-4 overflow-x-scroll	scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700 sm:h-full">
            {apisList[0].examples?.map((example, index) => (
              <button
                onClick={() => changeCodeExample(example)}
                key={example.codeUrl}
                className={cn(
                  "w-64 min-w-[16rem] p-4 transition-colors duration-300 sm:w-full sm:rounded",
                  "border-px border border-slate-900 bg-slate-900 text-slate-300 transition duration-300 hover:bg-slate-800"
                )}
              >
                {example.title}
              </button>
            ))}
          </div>
          {selectedExample && <CodeExample example={selectedExample} />} */}
        </>
      )}
    </div>
  );
}
