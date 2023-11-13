import { QueryClientProvider } from "react-query";
import { CodeExample } from "~/routes/resources.codeexample";
import { Api, ApiExample } from "~/services/externalApis/apis.server";
import { Header1, Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { cn } from "~/utils/cn";
import { useState } from "react";

export function CustomHelp({ api }: { api: Api }) {
  const [selectedExample, setSelectedExample] = useState(api.examples?.[0]);

  const changeCodeExample = (example: ApiExample) => {
    setSelectedExample(example);
  };

  return (
    <div className="mt-4">
      <Header1 className="mb-2">You can use any API with requests or an SDK</Header1>
      <Header2 className="mb-2">How to use an SDK</Header2>
      <Paragraph spacing>
        You can call SDK methods from inside the run function, but you should wrap them in a Task to
        make sure they're resumable.
      </Paragraph>
      <Paragraph spacing>Here's an example with the official GitHub SDK</Paragraph>
      {api.examples && api.examples.length > 0 && (
        <>
          <div className=" flex w-full flex-row gap-4 overflow-x-scroll	scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700 sm:h-full  lg:w-[22rem] lg:flex-col">
            {api.examples?.map((example, index) => (
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
    </div>
  );
}
