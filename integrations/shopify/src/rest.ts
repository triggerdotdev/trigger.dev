import { PageInfo, Session } from "@shopify/shopify-api";
import { OmitIndexSignature, Optional, SomeNonNullable } from "@trigger.dev/integration-kit";
import { z } from "zod";
import { ShopifyRestResources, ShopifyRunTask } from "./index";
import { basicProperties, serializeShopifyResource } from "./utils";
import {
  RecursiveShopifySerializer,
  ResourcesWithStandardMethods,
  ShopifyInputType,
} from "./types";

type ResourceArrayWithIndexSignature<T extends any[]> = T extends Array<infer U>
  ? Array<U & { [key: string]: any }>
  : never;

type RecursiveSomeNonNullable<T, TSome> = T extends object
  ? T extends Array<infer U>
    ? Array<RecursiveSomeNonNullable<U, TSome extends keyof U ? TSome : never>>
    : SomeNonNullable<T, TSome extends keyof T ? TSome : never>
  : T;

type AllReturnType<
  TResource extends ShopifyRestResources[ResourcesWithStandardMethods],
  TSerializedData extends Record<any, any>[] = RecursiveShopifySerializer<
    Awaited<ReturnType<TResource["all"]>>["data"]
  >,
> = Promise<{
  data: ResourceArrayWithIndexSignature<RecursiveSomeNonNullable<TSerializedData, "id">>;
  pageInfo?: PageInfo;
}>;

type CountReturnType = Promise<{ count: number }>;

type DeleteReturnType = Promise<void>;

type FindReturnType<
  TResource extends ShopifyRestResources[ResourcesWithStandardMethods],
  TSerialized extends Record<any, any> = RecursiveShopifySerializer<InstanceType<TResource>>,
> = Promise<
  | (SomeNonNullable<TSerialized, "id"> & {
      [key: string]: any;
    })
  | null
>;

type SaveReturnType<
  TResource extends ShopifyRestResources[ResourcesWithStandardMethods],
  TUpdate extends boolean,
  TFromData extends any,
> = Promise<
  TUpdate extends true
    ? SomeNonNullable<RecursiveShopifySerializer<TResource["prototype"]>, "id">
    : TFromData
>;

type HasOptionalSession = {
  session?: Session;
};

type WithRequiredSession<T = any> = T & {
  session: Session;
};

export class Resource<
  TResourceType extends ResourcesWithStandardMethods,
  TResource extends ShopifyRestResources[TResourceType] = ShopifyRestResources[TResourceType],
> {
  constructor(
    private runTask: ShopifyRunTask,
    private session: Session,
    private resourceType: TResourceType
  ) {}

  #withSession<TParams extends HasOptionalSession>(params: TParams): WithRequiredSession<TParams> {
    const { session, ...paramsWithoutSession } = params;

    return {
      session: session ?? this.session,
      ...paramsWithoutSession,
    } as WithRequiredSession<TParams>;
  }

  /**
   * Fetch a single resource by its ID.
   */
  async find(
    key: string,
    params: Optional<Parameters<TResource["find"]>[0], "session">
  ): FindReturnType<TResource> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const resource = (await client.rest[this.resourceType].find(
          this.#withSession(params)
        )) as Awaited<ReturnType<TResource["find"]>>;

        return JSON.parse(JSON.stringify(resource));
      },
      {
        name: `Find ${this.resourceType}`,
        params,
        properties: basicProperties(params),
      }
    );
  }

  async #allSinglePage(
    key: string,
    pageNumber: number,
    params?: Optional<Parameters<TResource["all"]>[0], "session">
  ): AllReturnType<TResource> {
    const { session, ...paramsWithoutSession } = params ?? {};

    return this.runTask(
      `${key}-page-${String(pageNumber)}`,
      async (client, task, io) => {
        const allResponse = await client.rest[this.resourceType].all(
          this.#withSession(params ?? {})
        );

        task.outputProperties = [
          {
            label: `${this.resourceType}s`,
            text: String(allResponse.data.length),
          },
        ];

        return {
          data: serializeShopifyResource(allResponse.data) as Awaited<
            AllReturnType<TResource>
          >["data"],
          pageInfo: allResponse.pageInfo,
        };
      },
      {
        name: `Get All ${this.resourceType}s`,
        params: paramsWithoutSession,
        properties: [
          {
            label: "Page Number",
            text: String(pageNumber),
          },
        ],
      }
    );
  }

  /**
   * Fetch all resources of a given type.
   */
  async all(
    key: string,
    params?: Optional<OmitIndexSignature<Parameters<TResource["all"]>[0]>, "session"> & {
      autoPaginate?: boolean;
      limit?: number;
    }
  ): AllReturnType<TResource> {
    return this.runTask(
      key,
      async (client, task, io) => {
        let pageNumber = 0;

        const { data, pageInfo: firstPageInfo } = await this.#allSinglePage(
          key,
          pageNumber++,
          params
        );

        let pageInfo = firstPageInfo;

        if (params?.autoPaginate && pageInfo) {
          while (pageInfo.nextPage) {
            const { data: moreData, pageInfo: morePageInfo } = await this.#allSinglePage(
              key,
              pageNumber++,
              {
                ...params,
                ...pageInfo.nextPage.query,
              }
            );

            data.push(...(moreData as any));

            pageInfo.nextPage = morePageInfo?.nextPage;
          }
        }

        task.outputProperties = [
          {
            label: `Total ${this.resourceType}s`,
            text: String(data.length),
          },
        ];

        return { data, pageInfo };
      },
      {
        name: `Get All ${this.resourceType}s`,
        params,
        properties: [
          {
            label: "Auto Paginate",
            text: String(!!params?.autoPaginate),
          },
          ...(params?.limit
            ? [
                {
                  label: "Limit",
                  text: String(params.limit),
                },
              ]
            : []),
        ],
      }
    );
  }

  /**
   * Fetch the number of resources of a given type.
   */
  async count(
    key: string,
    params?: Optional<OmitIndexSignature<Parameters<TResource["count"]>[0]>, "session">
  ): CountReturnType {
    return this.runTask(
      key,
      async (client, task, io) => {
        const countResponse = await client.rest[this.resourceType].count(
          this.#withSession(params ?? {})
        );

        const CountResponseSchema = z.object({
          count: z.number(),
        });

        const parsed = CountResponseSchema.safeParse(countResponse);

        if (!parsed.success) {
          return JSON.parse(JSON.stringify(countResponse));
        }

        task.outputProperties = [
          {
            label: "Total",
            text: String(parsed.data.count),
          },
        ];

        return parsed.data;
      },
      {
        name: `Count ${this.resourceType}s`,
        params,
      }
    );
  }

  /**
   * Create or update a resource of a given type. The resource will be created if no ID is specified.
   */
  async save<TFromData extends ShopifyInputType[TResourceType], TUpdate extends boolean = true>(
    key: string,
    params: {
      update?: TUpdate;
      fromData: TFromData;
      session?: Session;
    }
  ): SaveReturnType<TResource, TUpdate, TFromData> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const resource = new client.rest[this.resourceType](this.#withSession(params));

        // mutate resource object with upserted data by default
        await resource.save({ update: params.update ?? true });

        return JSON.parse(JSON.stringify(resource));
      },
      {
        name: `Upsert ${this.resourceType}`,
        params,
        properties: [
          ...(params.fromData.id ? basicProperties({ id: params.fromData.id }) : []),
          {
            label: "Action",
            text: params.fromData.id ? "Update" : "Create",
          },
        ],
      }
    );
  }

  /**
   * Delete an existing resource.
   */
  async delete(
    key: string,
    params: Optional<Parameters<TResource["delete"]>[0], "session">
  ): DeleteReturnType {
    return this.runTask(
      key,
      async (client, task, io) => {
        await client.rest[this.resourceType].delete(this.#withSession(params));
        return;
      },
      {
        name: `Delete ${this.resourceType}`,
        params,
        properties: basicProperties(params),
      }
    );
  }
}

export class Rest {
  constructor(
    private runTask: ShopifyRunTask,
    private session: Session
  ) {}
}

interface MergeProxyConstructor {
  new <TTarget extends Record<any, any>, TResult extends Record<any, any>>(
    target: TTarget,
    handler: ProxyHandler<TResult>
  ): TTarget & TResult;
}

type ResourceMap = {
  [KResourceType in ResourcesWithStandardMethods]: Resource<KResourceType>;
};

const RestProxy = Proxy as MergeProxyConstructor;

export const restProxy = (rest: Rest, session: Session, runTask: ShopifyRunTask) =>
  new RestProxy<Rest, ResourceMap>(rest, {
    get: (target, resourceType, receiver) => {
      return new Resource(runTask, session, resourceType as ResourcesWithStandardMethods);
    },
  });
