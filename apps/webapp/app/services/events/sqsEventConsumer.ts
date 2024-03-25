import { Message, SQSClient } from "@aws-sdk/client-sqs";
import { SendEventBodySchema } from "@trigger.dev/core";
import { Consumer } from "sqs-consumer";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { authenticateApiKey } from "../apiAuth.server";
import { logger, trace } from "../logger.server";
import { IngestSendEvent } from "./ingestSendEvent.server";

type SqsEventConsumerOptions = {
  queueUrl: string;
  /** This cannot be higher than the AWS limit of 10. */
  batchSize: number;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pollingWaitTimeMs: number;
};

const messageSchema = SendEventBodySchema.extend({
  apiKey: z.string(),
});

export class SqsEventConsumer {
  readonly #ingestEventService: IngestSendEvent;
  readonly #consumer: Consumer;

  constructor(
    readonly prismaClient: PrismaClientOrTransaction = prisma,
    options: SqsEventConsumerOptions
  ) {
    this.#ingestEventService = new IngestSendEvent();

    logger.debug("SqsEventConsumer starting", {
      queueUrl: options.queueUrl,
      region: options.region,
    });

    this.#consumer = Consumer.create({
      queueUrl: options.queueUrl,
      batchSize: options.batchSize,
      sqs: new SQSClient({
        region: options.region,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      }),
      handleMessage: async (message) => {
        await trace({ sqsMessage: message }, async () => await this.#processEvent(message));
      },
    });

    this.#consumer.on("error", (err, message) => {
      logger.error("SqsEventConsumer error", { error: err.message, sqsMessage: message });
      //todo what do we want to do here?
    });

    this.#consumer.on("processing_error", (err, message) => {
      logger.error("SqsEventConsumer processing_error", {
        error: err.message,
        sqsMessage: message,
      });
      //todo what do we want to do here?
    });

    this.#consumer.on("timeout_error", (err, message) => {
      logger.error("SqsEventConsumer timeout_error", { error: err.message, sqsMessage: message });
      //todo what do we want to do here?
    });

    //Stop the consumer if the process is terminated
    process.on("SIGTERM", () => {
      this.stop();
    });

    this.#consumer.start();
  }

  public stop() {
    logger.debug("SqsEventConsumer stopping");
    this.#consumer.stop({ abort: true });
  }

  async #processEvent(message: Message) {
    logger.debug("SqsEventConsumer processing event");

    //parse the body
    if (!message.Body) {
      logger.error("SqsEventConsumer message has no body");
      return;
    }

    const body = messageSchema.safeParse(JSON.parse(message.Body));
    if (!body.success) {
      logger.error("SqsEventConsumer message body is invalid", {
        error: fromZodError(body.error).message,
      });
      return;
    }

    //authenticate API Key
    const authenticationResult = await authenticateApiKey(body.data.apiKey);
    if (!authenticationResult) {
      logger.warn("SqsEventConsumer message has invalid API key");
      return;
    }

    const authenticatedEnv = authenticationResult.environment;

    logger.info("sqs_event", { event: body.data.event, options: body.data.options });

    const event = await this.#ingestEventService.call(
      authenticatedEnv,
      body.data.event,
      body.data.options
    );

    if (!event) {
      logger.error("SqsEventConsumer failed to create event");
      return;
    }

    logger.debug("SqsEventConsumer processed event", { event });
  }
}

export function getSharedSqsEventConsumer() {
  if (
    env.AWS_SQS_QUEUE_URL &&
    env.AWS_SQS_REGION &&
    env.AWS_SQS_ACCESS_KEY_ID &&
    env.AWS_SQS_SECRET_ACCESS_KEY
  ) {
    const consumer = new SqsEventConsumer(undefined, {
      queueUrl: env.AWS_SQS_QUEUE_URL,
      batchSize: env.AWS_SQS_BATCH_SIZE,
      pollingWaitTimeMs: env.AWS_SQS_WAIT_TIME_MS,
      region: env.AWS_SQS_REGION,
      accessKeyId: env.AWS_SQS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SQS_SECRET_ACCESS_KEY,
    });

    return consumer;
  }
}
