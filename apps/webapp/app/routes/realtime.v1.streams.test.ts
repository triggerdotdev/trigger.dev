import { ActionFunctionArgs } from "@remix-run/server-runtime";

export async function action({ request }: ActionFunctionArgs) {
  if (!request.body) {
    return new Response("No body provided", { status: 400 });
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (buffer) {
          const data = JSON.parse(buffer);
          console.log(`${new Date().toISOString()} Received data at end:`, data);
          // You can process the data as needed
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          const data = JSON.parse(line);
          console.log(`${new Date().toISOString()} Received data:`, data);
          // You can process each data chunk as needed
        }
      }
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("Error processing stream:", error);
    return new Response(null, { status: 500 });
  }
}
