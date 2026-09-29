import { describe, expect, it, vi } from "vitest";
import type {
  BillingController,
  BillingPlugin,
  ProvisionBillingCustomerParams,
} from "@trigger.dev/plugins";
import { okAsync } from "neverthrow";
import loader, { LazyController } from "./index.js";

function makeStubController(overrides: Partial<BillingController> = {}): BillingController {
  const stub: BillingController = {
    async isUsingPlugin() {
      return true;
    },
    getCustomer(organizationId: string) {
      return okAsync({ organizationId, billingCustomerId: "cus_stub" });
    },
    provisionCustomer(params: ProvisionBillingCustomerParams) {
      return okAsync({
        organizationId: params.organizationId,
        billingCustomerId: "cus_stub",
        outcome: "created" as const,
      });
    },
    ...overrides,
  };
  return stub;
}

function makePluginModule(controller: BillingController): { default: BillingPlugin } {
  return { default: { create: () => controller } };
}

function moduleNotFound(specifier: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
  error.code = "ERR_MODULE_NOT_FOUND";
  return error;
}

describe("billing loader", () => {
  it("uses the plugin when the import resolves", async () => {
    const controller = new LazyController({
      importer: async () => makePluginModule(makeStubController()),
    });

    await expect(controller.isUsingPlugin()).resolves.toBe(true);

    const result = await controller.provisionCustomer({ organizationId: "org_1", name: "Acme" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      organizationId: "org_1",
      billingCustomerId: "cus_stub",
      outcome: "created",
    });
  });

  it("imports the plugin from the @triggerdotdev/plugins/billing subpath", async () => {
    const importer = vi.fn(async () => makePluginModule(makeStubController()));

    const controller = new LazyController({ importer });
    await controller.isUsingPlugin();

    expect(importer).toHaveBeenCalledWith("@triggerdotdev/plugins/billing");
  });

  it("passes the host database config through to the plugin factory", async () => {
    const create = vi.fn(() => makeStubController());
    const controller = new LazyController({
      importer: async () => ({ default: { create } }),
      database: { writerUrl: "postgres://writer", readerUrl: "postgres://reader" },
    });

    await controller.isUsingPlugin();

    expect(create).toHaveBeenCalledWith({
      database: { writerUrl: "postgres://writer", readerUrl: "postgres://reader" },
    });
  });

  it("falls back when the plugin is not installed", async () => {
    const controller = new LazyController({
      importer: async () => {
        throw moduleNotFound("@triggerdotdev/plugins/billing");
      },
    });

    await expect(controller.isUsingPlugin()).resolves.toBe(false);

    const result = await controller.provisionCustomer({ organizationId: "org_1", name: "Acme" });
    expect(result._unsafeUnwrapErr()).toBe("feature_disabled");
  });

  it("falls back loudly when the plugin is present but fails to initialise", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const controller = new LazyController({
      importer: async () => {
        throw moduleNotFound("some-transitive-dependency");
      },
    });

    await expect(controller.isUsingPlugin()).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("falls back without rejecting when the plugin's create() throws synchronously", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const controller = new LazyController({
      importer: async () => ({
        default: {
          create: () => {
            throw new Error("bad database config");
          },
        },
      }),
    });

    await expect(controller.isUsingPlugin()).resolves.toBe(false);
    const result = await controller.provisionCustomer({ organizationId: "org_1", name: "Acme" });
    expect(result._unsafeUnwrapErr()).toBe("feature_disabled");
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("forceFallback skips the importer entirely", async () => {
    const importer = vi.fn(async () => makePluginModule(makeStubController()));

    const controller = loader.create({ forceFallback: true, importer });

    await expect(controller.isUsingPlugin()).resolves.toBe(false);
    expect(importer).not.toHaveBeenCalled();
  });

  it("fallback reads report no customer rather than an error", async () => {
    const controller = loader.create({ forceFallback: true });

    const result = await controller.getCustomer("org_1");
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("loads the plugin once and reuses it across calls", async () => {
    const importer = vi.fn(async () => makePluginModule(makeStubController()));
    const controller = new LazyController({ importer });

    await Promise.all([
      controller.isUsingPlugin(),
      controller.getCustomer("org_1"),
      controller.provisionCustomer({ organizationId: "org_1", name: "Acme" }),
    ]);

    expect(importer).toHaveBeenCalledTimes(1);
  });
});
