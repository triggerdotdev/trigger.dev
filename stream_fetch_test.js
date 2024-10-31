class MetadataStream {
  constructor(options) {
    this.options = options;
    this.controller = new AbortController();
    this.serverQueue = [];
    this.consumerQueue = [];

    const { serverIterator, consumerIterator } = this.createTeeIterators();
    this.serverIterator = serverIterator;
    this.consumerIterator = consumerIterator;

    this.streamPromise = this.initializeServerStream();
  }

  createTeeIterators() {
    const teeIterator = (queue) => ({
      next: () => {
        if (queue.length === 0) {
          const result = this.options.iterator.next();
          this.serverQueue.push(result);
          this.consumerQueue.push(result);
        }
        return queue.shift();
      },
    });

    return {
      serverIterator: teeIterator(this.serverQueue),
      consumerIterator: teeIterator(this.consumerQueue),
    };
  }

  initializeServerStream() {
    const serverIterator = this.serverIterator;

    const serverStream = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await serverIterator.next();
          if (done) {
            controller.close();
            return;
          }

          console.log("Server sent:", value, new Date().toISOString());

          controller.enqueue(JSON.stringify(value) + "\n");
        } catch (err) {
          controller.error(err);
        }
      },
      cancel: () => this.controller.abort(),
    });

    return fetch(
      `${this.options.baseUrl}/realtime/v1/streams/${this.options.runId}/${this.options.key}`,
      {
        method: "POST",
        headers: {},
        body: serverStream,
        duplex: "half",
        signal: this.controller.signal,
      }
    ).catch((error) => {
      console.error("Error in stream:", error);
    });
  }

  async wait() {
    return this.streamPromise.then(() => void 0);
  }

  [Symbol.asyncIterator]() {
    return this.consumerIterator;
  }
}

// Example usage:
async function* generateSampleData() {
  const items = [
    { type: "start", timestamp: Date.now() },
    { type: "progress", value: 25 },
    { type: "progress", value: 50 },
    { type: "progress", value: 75 },
    { type: "complete", timestamp: Date.now() },
  ];

  for (const item of items) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    yield item;
  }
}

async function runTest() {
  const { OpenAI } = require("./references/v3-catalog/node_modules/openai");
  const openai = new OpenAI();

  const result = await openai.chat.completions.create({
    model: "chatgpt-4o-latest",
    messages: [
      {
        role: "system",
        content: "Can you summarize the plot of The Matrix?",
      },
    ],
    stream: true,
  });

  const stream = new MetadataStream({
    baseUrl: "http://localhost:3030",
    runId: "test_run_1234",
    key: "openai",
    iterator: result[Symbol.asyncIterator](),
  });

  // Consume the stream
  // for await (const value of stream) {
  //   console.log("Consumer received:", value, new Date().toISOString());
  // }

  await stream.wait();
  console.log("Stream completed", new Date().toISOString());
}

runTest().catch(console.error);
