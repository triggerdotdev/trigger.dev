export class LineTransformStream extends TransformStream<string, string[]> {
  private buffer = "";

  constructor() {
    super({
      transform: (chunk, controller) => {
        // Append the chunk to the buffer
        this.buffer += chunk;

        // Split on newlines
        const lines = this.buffer.split("\n");

        // The last element might be incomplete, hold it back in buffer
        this.buffer = lines.pop() || "";

        // Filter out empty or whitespace-only lines
        const fullLines = lines.filter((line) => line.trim().length > 0);

        // If we got any complete lines, emit them as an array
        if (fullLines.length > 0) {
          controller.enqueue(fullLines);
        }
      },
      flush: (controller) => {
        // On stream end, if there's leftover text, emit it as a single-element array
        const trimmed = this.buffer.trim();
        if (trimmed.length > 0) {
          controller.enqueue([trimmed]);
        }
      },
    });
  }
}
