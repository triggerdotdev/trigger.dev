import { useState } from "react";
import { CodeExample } from "~/routes/resources.codeexample";
import { type Api } from "~/services/externalApis/apis.server";
import { cn } from "~/utils/cn";
import { Feedback } from "../Feedback";
import { Header1, Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { TextLink } from "../primitives/TextLink";

export function CustomHelp({ api }: { api: Api }) {
  const [selectedExample, setSelectedExample] = useState(0);

  const changeCodeExample = (index: number) => {
    setSelectedExample(index);
  };

  return (
    <div className="mt-4">
      <Header1 className="mb-2">Using {api.name} with an SDK or requests</Header1>
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

      {api.examples && api.examples.length > 0 ? (
        <>
          <Header2 className="mb-2">Example {api.name} code</Header2>
          <Paragraph spacing className="mb-4">
            This is how you can use {api.name} with Trigger.dev. This code can be copied and
            modified to suit your use-case.
          </Paragraph>
          {api.examples.length > 1 && (
            <div className=" flex w-full flex-row gap-4 overflow-x-scroll	scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
              {api.examples?.map((example, index) => (
                <button
                  onClick={() => changeCodeExample(index)}
                  key={example.codeUrl}
                  className={cn(
                    "w-64 min-w-[16rem] p-2 transition-colors duration-300 sm:w-full sm:rounded",
                    "border-px focus:border-px cursor-pointer border border-charcoal-900 bg-charcoal-900 text-charcoal-300 transition duration-300  hover:bg-charcoal-800 focus:border focus:border-indigo-600"
                  )}
                >
                  {example.title}
                </button>
              ))}
            </div>
          )}
          <CodeExample example={api.examples[selectedExample]} />
        </>
      ) : (
        <>
          <Header2 className="mb-2">Getting started with {api.name}</Header2>
          <Paragraph spacing className="mb-4">
            We recommend searching for the official {api.name} Node SDK. If they have one, you can
            install it and then use their API documentation to get started and create tasks. If they
            don't, there are often third party SDKs you can use instead.
          </Paragraph>
          <Paragraph spacing className="mb-4">
            Please{" "}
            <Feedback
              button={
                <span className="cursor-pointer text-indigo-500 transition duration-300 hover:text-indigo-400">
                  reach out to us
                </span>
              }
              defaultValue="help"
            />{" "}
            if you're having any issues connecting to {api.name}, we'll help you get set up as
            quickly as possible.
          </Paragraph>
        </>
      )}
    </div>
  );
}
