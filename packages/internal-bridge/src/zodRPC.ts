import { z, ZodError } from "zod";
import { createHash } from "node:crypto";
import { IConnection } from "./types";

export const RPCMessageSchema = z.object({
  id: z.string(),
  methodName: z.string(),
  data: z.any(),
  kind: z.enum(["CALL", "RESPONSE"]),
});

export type RPCMessage = z.infer<typeof RPCMessageSchema>;

interface TransmitterSchema {
  [key: string]: {
    request:
      | z.ZodFirstPartySchemaTypes
      | z.ZodDiscriminatedUnion<any, any, any>;
    response:
      | z.ZodFirstPartySchemaTypes
      | z.ZodDiscriminatedUnion<any, any, any>;
  };
}

export type ZodRPCHandlers<ReceiverSchema extends TransmitterSchema> = {
  [K in keyof ReceiverSchema]: (
    data: z.infer<ReceiverSchema[K]["request"]>
  ) => Promise<z.infer<ReceiverSchema[K]["response"]>>;
};

type ZodRPCOptions<
  SenderSchema extends TransmitterSchema,
  ReceiverSchema extends TransmitterSchema
> = {
  connection: IConnection;
  sender: SenderSchema;
  receiver: ReceiverSchema;
  handlers: ZodRPCHandlers<ReceiverSchema>;
};

type onResponseCallback = (data: any) => void;

export class ZodRPC<
  SenderSchema extends TransmitterSchema,
  ReceiverSchema extends TransmitterSchema
> {
  #connection: IConnection;
  #sender: SenderSchema;
  #receiver: ReceiverSchema;
  #handlers: ZodRPCHandlers<ReceiverSchema>;
  #pendingCalls = new Map<string, onResponseCallback>();

  constructor(options: ZodRPCOptions<SenderSchema, ReceiverSchema>) {
    this.#connection = options.connection;
    this.#sender = options.sender;
    this.#receiver = options.receiver;
    this.#handlers = options.handlers;

    this.#connection.onMessage.attach(this.#onMessage.bind(this));
  }

  async #onMessage(rawData: unknown) {
    try {
      const data = RPCMessageSchema.parse(JSON.parse(rawData as string));

      if (data.kind === "CALL") {
        await this.#onCall(data);
      }

      if (data.kind === "RESPONSE") {
        await this.#onResponse(data);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async #onCall(message: RPCMessage) {
    try {
      await this.#handleCall(message);
    } catch (callError) {
      if (callError instanceof ZodError) {
        console.error(
          `[ZodRPC] Received invalid call\n\n${JSON.stringify(message)}: `,
          callError.flatten()
        );
      } else {
        console.error(
          `[ZodRPC] Error handling call\n\n${JSON.stringify(message)}: `,
          callError
        );
      }
    }
  }

  async #onResponse(message: RPCMessage) {
    try {
      await this.#handleResponse(message);
    } catch (callError) {
      if (callError instanceof ZodError) {
        console.error(
          `[ZodRPC] Received invalid response\n\n${JSON.stringify(message)}: `,
          callError.flatten()
        );
      } else {
        console.error(
          `[ZodRPC] Error handling response\n\n${JSON.stringify(message)}: `,
          callError
        );
      }
    }
  }

  public send<K extends keyof SenderSchema>(
    key: K,
    data: z.infer<SenderSchema[K]["request"]>
  ) {
    const id = generateStableId(this.#connection.id, key as string, data);

    const message = packageMessage({ id, methodName: key as string, data });

    return new Promise<z.infer<SenderSchema[K]["response"]>>(
      (resolve, reject) => {
        this.#pendingCalls.set(id, (rawResponseText: string) => {
          try {
            const parsed = this.#sender[key]["response"].parse(rawResponseText);

            return resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });

        this.#connection.send(message).catch((err) => reject(err));
      }
    );
  }

  async #handleCall(message: RPCMessage) {
    const receiver = this.#receiver;
    type MethodKeys = keyof typeof receiver;

    const methodName = message.methodName as MethodKeys;

    const method: ReceiverSchema[MethodKeys] | undefined =
      this.#receiver[methodName];

    if (!method) {
      throw new Error(`There is no method for ${message.methodName}`);
    }

    // struggling to get real inference here
    const inputs = method.request.parse(message.data);

    const handler = this.#handlers[methodName];

    const returnValue = await handler(inputs);

    const preparedResponseText = packageResponse({
      id: message.id,
      methodName: methodName as string, //??
      data: returnValue,
    });

    try {
      await this.#connection.send(preparedResponseText);
    } catch (err) {
      console.error("Failed sending response", preparedResponseText, err);
    }

    return;
  }

  async #handleResponse(message: RPCMessage) {
    const responseCallback = this.#pendingCalls.get(message.id);
    if (!responseCallback) return;

    responseCallback(message.data);

    this.#pendingCalls.delete(message.id);
  }
}

// Generates a stableId for a given request, based on:
// - The connection id
// - The request key
// - The request data (serialized)
// Returns a hash of the above
function generateStableId(
  connId: string,
  reqKey: string,
  reqData: any
): string {
  // Serialize the request data
  const serializedData = JSON.stringify(reqData);

  // Concatenate the connection id, request key, and serialized data
  const inputString = connId + reqKey + serializedData;

  // Generate a hash of the input string using the SHA-256 algorithm
  const hash = createHash("sha256").update(inputString).digest("hex");

  // Return the hash
  return hash;
}

function packageMessage({ id, methodName, data }: Omit<RPCMessage, "kind">) {
  const callerData: RPCMessage = {
    id,
    kind: "CALL",
    data,
    methodName,
  };

  return JSON.stringify(callerData);
}

function packageResponse({ id, methodName, data }: Omit<RPCMessage, "kind">) {
  const preparedResponseText: RPCMessage = {
    id: id,
    kind: "RESPONSE",
    methodName: methodName,
    data,
  };
  return JSON.stringify(preparedResponseText);
}
