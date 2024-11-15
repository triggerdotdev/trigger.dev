import { openai } from "@ai-sdk/openai";
import { logger, metadata, schemaTask } from "@trigger.dev/sdk/v3";
import { streamUI } from "ai/rsc";
import { z } from "zod";
import { createStreamableUI } from "ai/rsc";
import { renderToReadableStream } from "react-dom/server";

const LoadingComponent = () => <div className="animate-pulse p-4">getting weather...</div>;

const getWeather = async (location: string) => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return "82°F️ ☀️";
};

interface WeatherProps {
  location: string;
  weather: string;
}

const WeatherComponent = (props: WeatherProps) => (
  <div className="border border-neutral-200 p-4 rounded-lg max-w-fit">
    The weather in {props.location} is {props.weather}
  </div>
);

export const openaiStreamingRSC = schemaTask({
  id: "openai-streaming-rsc",
  description: "Stream RSC data from OpenAI to get the weather",
  schema: z.object({
    model: z.string().default("chatgpt-4o-latest"),
    prompt: z.string().default("Hello, how are you?"),
  }),
  run: async ({ model, prompt }) => {
    logger.info("Running OpenAI model", { model, prompt });

    const result = await streamUI({
      model: openai(model),
      prompt,
      text: ({ content }) => <div>{content}</div>,
      tools: {
        getWeather: {
          description: "Get the weather for a location",
          parameters: z.object({ location: z.string() }),
          generate: async function* ({ location }) {
            yield <LoadingComponent />;
            const weather = await getWeather(location);
            return <WeatherComponent weather={weather} location={location} />;
          },
        },
      },
    });

    const stream = await metadata.stream("openai", result.stream);

    let text = "";

    for await (const chunk of stream) {
      logger.log("Received chunk", { chunk });

      if (chunk.type === "text-delta") {
        text += chunk.textDelta;
      }
    }

    return { text, value: result.value };
  },
});

function App() {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/styles.css"></link>
        <title>My app</title>
      </head>
      <body></body>
    </html>
  );
}

export const weatherUI = schemaTask({
  id: "weather-ui",
  description: "Stream weather UI data from this task to the client",
  schema: z.object({
    message: z.string(),
  }),
  run: async ({ message }) => {
    const weatherUI = createStreamableUI();

    weatherUI.update(<div style={{ color: "gray" }}>Loading...</div>);

    setTimeout(() => {
      weatherUI.done(<div>{message}</div>);
    }, 1000);

    const readableStream = await renderToReadableStream(<App />, {
      onError(error, errorInfo) {
        logger.error("Error rendering UI", { error, errorInfo });
      },
    });

    const stream = await metadata.stream("weather-ui", readableStream);

    for await (const chunk of stream) {
      logger.log("Received chunk", { chunk });
    }

    return weatherUI.value;
  },
});
