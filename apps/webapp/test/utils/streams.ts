export async function convertResponseStreamToArray(response: Response): Promise<string[]> {
  return convertReadableStreamToArray(response.body!.pipeThrough(new TextDecoderStream()));
}

export async function convertResponseSSEStreamToArray(response: Response): Promise<string[]> {
  const parseSSEDataTransform = new TransformStream<string>({
    async transform(chunk, controller) {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          controller.enqueue(line.slice(6));
        }
      }
    },
  });

  return convertReadableStreamToArray(
    response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(parseSSEDataTransform)
  );
}

export async function convertReadableStreamToArray<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const result: T[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result.push(value);
  }

  return result;
}

export function convertArrayToReadableStream<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      try {
        for (const value of values) {
          controller.enqueue(value);
        }
      } finally {
        controller.close();
      }
    },
  });
}
