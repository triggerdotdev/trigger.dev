export async function performSearch(query: string, signal: AbortSignal) {
  const body = callToolBody("SearchTriggerDev", { query });

  const response = await fetch("https://trigger.dev/docs/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    signal,
    body: JSON.stringify(body),
  });

  const data = await parseResponse(response);
  return data;
}

async function parseResponse(response: Response) {
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return parseSSEResponse(response);
  } else {
    return parseJSONResponse(response);
  }
}

async function parseJSONResponse(response: Response) {
  const data = await response.json();
  return data;
}

// Get the first data: event and return the parsed JSON of the event
async function parseSSEResponse(response: Response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    throw new Error("No reader found");
  }

  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream closed before data arrived");

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n"); // SSE delimiter
    buffer = events.pop()!; // keep incomplete

    for (const evt of events) {
      for (const line of evt.split("\n")) {
        if (line.startsWith("data:")) {
          const json = line.slice(5).trim();
          return JSON.parse(json); // ✅ got it
        }
      }
    }
  }

  throw new Error("No data: event found");
}

function callToolBody(tool: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: tool,
      arguments: args,
    },
  };
}
