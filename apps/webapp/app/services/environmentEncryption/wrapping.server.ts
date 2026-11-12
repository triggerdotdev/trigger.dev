import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { EnvironmentKeyWrappingProvider, Prisma } from "@trigger.dev/database";
import pLimit from "p-limit";
import { z } from "zod";
import type { EncryptionKeyring } from "~/utils/encryptionKeyring.server";
import { wrappingContext } from "./crypto.server";
import { environmentEncryptionTelemetry } from "./telemetry.server";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_REQUESTS = 16;
const MAX_QUEUED_REQUESTS = 256;

export type WrappingPolicy = {
  wrappingProvider: EnvironmentKeyWrappingProvider;
  wrappingKeyReference: string;
};
export class EnvironmentKeyUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Environment encryption key unavailable", options);
    this.name = "EnvironmentKeyUnavailableError";
  }
}

const localValue = z
  .object({
    nonce: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    ciphertext: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const kmsValue = z.object({ ciphertext: z.string().min(1) }).strict();

const kmsRequests = pLimit(MAX_CONCURRENT_REQUESTS);
// Platform credentials are shared across readers/writers; regions are operator-configured.
const kmsClients = new Map<string, KMSClient>();

export class EnvironmentKeyWrapper {
  constructor(private readonly keyring: EncryptionKeyring) {}

  #run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (kmsRequests.pendingCount >= MAX_QUEUED_REQUESTS) {
      environmentEncryptionTelemetry().failures.add(1, { reason: "kms_queue_full" });
      return Promise.reject(
        new EnvironmentKeyUnavailableError({ cause: new Error("KMS request queue is full") })
      );
    }
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return new Promise<T>((resolve, reject) => {
      const aborted = () => {
        environmentEncryptionTelemetry().failures.add(1, { reason: "kms_deadline" });
        reject(new EnvironmentKeyUnavailableError({ cause: signal.reason }));
      };
      signal.addEventListener("abort", aborted, { once: true });
      const pending = kmsRequests(() => {
        signal.throwIfAborted();
        return fn(signal);
      });
      pending.then(
        (result) => {
          signal.removeEventListener("abort", aborted);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        }
      );
    });
  }

  #client(policy: WrappingPolicy): KMSClient {
    const match =
      /^arn:(aws|aws-us-gov|aws-cn):kms:([a-z0-9-]+):[0-9]{12}:key\/[a-zA-Z0-9-]+$/.exec(
        policy.wrappingKeyReference
      );
    if (!match) throw new Error("Wrapping key must be a resolved KMS key ARN");
    const region = match[2]!;
    let client = kmsClients.get(region);
    if (!client) {
      client = new KMSClient({ region, maxAttempts: 3 });
      kmsClients.set(region, client);
    }
    return client;
  }

  async wrap(policy: WrappingPolicy, environmentId: string, keyId: string, key: Buffer) {
    const startedAt = performance.now();
    let outcome = "error";
    const context = wrappingContext(environmentId, keyId);
    try {
      if (policy.wrappingProvider === "PLATFORM_KEYRING") {
        const wrappingKey = this.keyring.keys.get(policy.wrappingKeyReference);
        if (!wrappingKey) throw new Error("Unknown wrapping key");
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
        cipher.setAAD(Buffer.from(JSON.stringify(context)));
        outcome = "success";
        return {
          wrappedKey: {
            nonce: nonce.toString("hex"),
            ciphertext: Buffer.concat([cipher.update(key), cipher.final()]).toString("hex"),
            tag: cipher.getAuthTag().toString("hex"),
          } satisfies Prisma.InputJsonValue,
          wrappingKeyReference: policy.wrappingKeyReference,
        };
      }
      const client = this.#client(policy);
      const result = await this.#run((signal) =>
        client.send(
          new EncryptCommand({
            KeyId: policy.wrappingKeyReference,
            Plaintext: key,
            EncryptionContext: context,
          }),
          { abortSignal: signal }
        )
      );
      if (!result.CiphertextBlob || !result.KeyId) throw new Error("KMS returned no wrapped key");
      outcome = "success";
      return {
        wrappedKey: { ciphertext: Buffer.from(result.CiphertextBlob).toString("base64") },
        wrappingKeyReference: result.KeyId,
      };
    } catch (cause) {
      outcome = "error";
      throw new EnvironmentKeyUnavailableError({ cause });
    } finally {
      environmentEncryptionTelemetry().keyOperationDuration.record(performance.now() - startedAt, {
        provider: policy.wrappingProvider,
        operation: "wrap",
        outcome,
      });
    }
  }

  async unwrap(policy: WrappingPolicy, environmentId: string, keyId: string, wrappedKey: unknown) {
    const startedAt = performance.now();
    let outcome = "error";
    const context = wrappingContext(environmentId, keyId);
    try {
      if (policy.wrappingProvider === "PLATFORM_KEYRING") {
        const wrappingKey = this.keyring.keys.get(policy.wrappingKeyReference);
        if (!wrappingKey) throw new Error("Unknown wrapping key");
        const value = localValue.parse(wrappedKey);
        const decipher = createDecipheriv(
          "aes-256-gcm",
          wrappingKey,
          Buffer.from(value.nonce, "hex")
        );
        decipher.setAAD(Buffer.from(JSON.stringify(context)));
        decipher.setAuthTag(Buffer.from(value.tag, "hex"));
        outcome = "success";
        return Buffer.concat([
          decipher.update(Buffer.from(value.ciphertext, "hex")),
          decipher.final(),
        ]);
      }
      const value = kmsValue.parse(wrappedKey);
      const client = this.#client(policy);
      const result = await this.#run((signal) =>
        client.send(
          new DecryptCommand({
            KeyId: policy.wrappingKeyReference,
            CiphertextBlob: Buffer.from(value.ciphertext, "base64"),
            EncryptionContext: context,
          }),
          { abortSignal: signal }
        )
      );
      if (!result.Plaintext || result.Plaintext.length !== 32)
        throw new Error("KMS returned an invalid key");
      outcome = "success";
      return Buffer.from(result.Plaintext);
    } catch (cause) {
      outcome = "error";
      throw new EnvironmentKeyUnavailableError({ cause });
    } finally {
      environmentEncryptionTelemetry().keyOperationDuration.record(performance.now() - startedAt, {
        provider: policy.wrappingProvider,
        operation: "unwrap",
        outcome,
      });
    }
  }
}
