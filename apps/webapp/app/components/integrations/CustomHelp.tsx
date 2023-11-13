import { QueryClientProvider } from "react-query";
import { CodeExample } from "~/routes/resources.codeexample";
import { Api } from "~/services/externalApis/apis.server";
import { Header1, Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";

export function CustomHelp({ api }: { api: Api }) {
  //Todo new function called 'examples', which you pass through the api object, in here you use the queryclient

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
          <CodeExample example={api.examples[0]} />
        </>
      )}

      <Header2 className="mb-2">How to use fetch</Header2>
      <Paragraph spacing>
        You can use the fetch API to make requests to any API. Or a different request library like
        axios if you'd prefer. Again wrapping the request in a Task will make sure it's resumable.
      </Paragraph>
    </div>
  );
}
