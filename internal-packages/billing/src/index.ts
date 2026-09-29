import type {
  BillingController,
  BillingCustomer,
  BillingCustomerError,
  BillingPlugin,
  PluginDatabaseConfig,
  ProvisionBillingCustomerParams,
  ProvisionBillingCustomerResult,
} from "@trigger.dev/plugins";
import { ResultAsync } from "neverthrow";
import { BillingFallback } from "./fallback.js";

export type {
  BillingController,
  BillingCustomer,
  BillingCustomerError,
  ProvisionBillingCustomerParams,
  ProvisionBillingCustomerResult,
} from "@trigger.dev/plugins";

export type BillingCreateOptions = {
  forceFallback?: boolean;
  importer?: (moduleName: string) => Promise<{ default: BillingPlugin }>;
  database?: PluginDatabaseConfig;
};

const MODULE_NAME = "@triggerdotdev/plugins/billing";

export class LazyController implements BillingController {
  private readonly _init: Promise<BillingController>;

  constructor(options?: BillingCreateOptions) {
    this._init = this.load(options);
    // Defensive: nothing awaits _init until the first method call, so if
    // load() ever rejected unexpectedly, it would surface as an
    // unhandledRejection and crash the process before then.
    this._init.catch(() => {});
  }

  private async load(options?: BillingCreateOptions): Promise<BillingController> {
    if (options?.forceFallback) {
      return new BillingFallback().create();
    }

    const importer =
      options?.importer ??
      ((m: string) => import(/* @vite-ignore */ m) as Promise<{ default: BillingPlugin }>);

    const imported = await ResultAsync.fromPromise(importer(MODULE_NAME), (error) => error);

    if (imported.isOk()) {
      const plugin = imported.value.default;
      const created = await ResultAsync.fromPromise(
        Promise.resolve().then(() => plugin.create({ database: options?.database })),
        (error) => error
      );

      if (created.isOk()) {
        console.log("Billing: using plugin implementation");
        return created.value;
      }

      console.error(
        "Billing: plugin found but failed to initialise; falling back to default implementation",
        created.error
      );
      return new BillingFallback().create();
    }

    // Node throws ERR_MODULE_NOT_FOUND both when the plugin is absent (expected
    // on OSS deployments) and when the plugin loaded but a transitive import
    // failed (a real bug). Disambiguate on the missing specifier.
    const error = imported.error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    const isModuleNotFound = code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";

    if (!isModuleNotFound || !message.includes(MODULE_NAME)) {
      console.error(
        "Billing: plugin found but failed to load; falling back to default implementation",
        error
      );
      return new BillingFallback().create();
    }

    if (process.env.BILLING_LOG_FALLBACK === "1" || process.env.BILLING_LOG_FALLBACK === "true") {
      console.log("Billing: no plugin installed (ERR_MODULE_NOT_FOUND); using fallback");
    }
    return new BillingFallback().create();
  }

  private c(): Promise<BillingController> {
    return this._init;
  }

  private call<T, E>(factory: (c: BillingController) => ResultAsync<T, E>): ResultAsync<T, E> {
    return ResultAsync.fromSafePromise(this.c().then(factory)).andThen((r) => r);
  }

  async isUsingPlugin(): Promise<boolean> {
    return (await this.c()).isUsingPlugin();
  }

  getCustomer(organizationId: string): ResultAsync<BillingCustomer | null, BillingCustomerError> {
    return this.call((c) => c.getCustomer(organizationId));
  }

  provisionCustomer(
    params: ProvisionBillingCustomerParams
  ): ResultAsync<ProvisionBillingCustomerResult, BillingCustomerError> {
    return this.call((c) => c.provisionCustomer(params));
  }
}

class Billing {
  create(options?: BillingCreateOptions): BillingController {
    return new LazyController(options);
  }
}

const loader = new Billing();

export default loader;
