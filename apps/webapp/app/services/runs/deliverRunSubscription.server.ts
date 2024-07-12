import { type RunNotification } from '@trigger.dev/core/schemas';
import { subtle } from "node:crypto";
import { type PrismaClient, prisma } from "~/db.server";
import { EndpointApi } from "../endpointApi.server";

// Infer the type of the #findSubscription method
type FoundSubscription = NonNullable<
  Awaited<ReturnType<DeliverRunSubscriptionService["_findSubscription"]>>
>;

type FoundRun = FoundSubscription["run"];

export class DeliverRunSubscriptionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const subscription = await this._findSubscription(id);

    if (!subscription) {
      return;
    }

    if (subscription.deliveredAt) {
      return;
    }

    if (subscription.status !== "ACTIVE") {
      return;
    }

    const { run } = subscription;

    const payload = this.#getPayload(run);

    const delivered = await this.#deliverPayload(subscription, payload);

    if (delivered) {
      await this.#prismaClient.jobRunSubscription.update({
        where: {
          id,
        },
        data: {
          deliveredAt: new Date(),
        },
      });
    } else {
      throw new Error(`Failed to deliver subscription ${id}`);
    }
  }

  async #deliverPayload(
    subscription: FoundSubscription,
    payload: RunNotification<any>
  ): Promise<boolean> {
    switch (subscription.recipientMethod) {
      case "WEBHOOK": {
        const url = subscription.recipient;

        const rawPayload = JSON.stringify(payload);
        const hashPayload = Buffer.from(rawPayload, "utf-8");
        const hmacSecret = Buffer.from(subscription.run.environment.apiKey, "utf-8");
        const key = await subtle.importKey(
          "raw",
          hmacSecret,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const signature = await subtle.sign("HMAC", key, hashPayload);
        const signatureHex = Buffer.from(signature).toString("hex");

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Trigger-Signature-256": signatureHex,
          },
          body: rawPayload,
        });

        if (!response.ok) {
          throw new Error(
            `Failed to deliver webhook to ${url}: [${response.status}] ${response.statusText}`
          );
        }

        return true;
      }
      case "ENDPOINT": {
        const endpointId = subscription.recipient;

        if (endpointId !== subscription.run.endpointId) {
          return true;
        }

        if (subscription.run.endpoint.url === null) {
          return true;
        }

        const client = new EndpointApi(
          subscription.run.environment.apiKey,
          subscription.run.endpoint.url
        );

        const response = await client.deliverRunNotification(payload);

        if (!response) {
          throw new Error(
            `Failed to deliver endpoint notification to ${subscription.run.endpoint.url}`
          );
        }

        if (!response.ok) {
          throw new Error(
            `Failed to deliver endpoint notification to ${subscription.run.endpoint.url}: [${response.status}] ${response.statusText}`
          );
        }

        return true;
      }
    }
  }

  private async _findSubscription(id: string) {
    return this.#prismaClient.jobRunSubscription.findUnique({
      where: {
        id,
      },
      include: {
        run: {
          include: {
            job: true,
            version: true,
            statuses: true,
            environment: true,
            organization: true,
            project: true,
            event: true,
            endpoint: true,
            tasks: {
              where: {
                status: "ERRORED",
              },
              take: 1,
              orderBy: {
                startedAt: "desc",
              },
              include: {
                attempts: true,
              },
            },
          },
        },
      },
    });
  }

  #getPayload(run: FoundRun): RunNotification<any> {
    const { id, job, version, statuses, environment, organization, project, event, tasks } = run;

    const task = tasks[0]
      ? {
          id: tasks[0].idempotencyKey,
          cacheKey: tasks[0].displayKey,
          status: tasks[0].status,
          name: tasks[0].name,
          icon: tasks[0].icon,
          startedAt: tasks[0].startedAt,
          error: tasks[0].output,
          params: tasks[0].params,
        }
      : undefined;

    const payload = {
      id,
      ok: run.status === "SUCCESS",
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      isTest: run.isTest,
      executionDurationInMs: run.executionDuration,
      executionCount: run.executionCount,
      job: {
        id: job.slug,
        version: version.version,
      },
      statuses: statuses.map((status) => ({
        key: status.key,
        label: status.label,
        state: status.state,
        data: status.data,
        history: status.history,
      })),
      environment: {
        slug: environment.slug,
        id: environment.id,
        type: environment.type,
      },
      organization: {
        slug: organization.slug,
        id: organization.id,
        title: organization.title,
      },
      project: {
        slug: project.slug,
        id: project.id,
        name: project.name,
      },
      invocation: {
        id: event.id,
        context: event.context,
        timestamp: event.timestamp,
        payload: event.payload,
      },
      ...(run.status === "SUCCESS"
        ? { output: run.output }
        : {
            error: run.output,
            task,
          }),
    };

    return payload as RunNotification<any>;
  }
}
