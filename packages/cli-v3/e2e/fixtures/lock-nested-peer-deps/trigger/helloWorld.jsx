import { task } from "@trigger.dev/sdk/v3";
import { renderToPipeableStream } from "react-dom/server";

function App() {
  return <div>Hello World</div>;
}

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload) => {
    const stream = renderToPipeableStream(<App />, {
      onShellReady() {
        stream.pipe(payload);
      },
    });
  },
});
