import {
  attempt,
  batchTriggerAndWait,
  buildRunPageScenario,
  httpRequest,
  log,
  run,
  runFunction,
  span,
  triggerAndWait,
} from "../mockTrace";

// A run that fans out: it triggers a batch of child runs and waits for them. One of the children
// triggers a batch of its own, so its attempts sit inside that child's attempt rather than under
// the root run. Every run succeeds.

const syncId = "sync_2026-10-06";
const productsPerBatch = 160;

// How long each batch spends upserting its products. The catalog queue runs five batches at a
// time, so the rest wait for a slot and reuse the machines the first ones started.
const upsertDurations = [1640, 2210, 1490, 1870, 1960, 1520, 2380, 1710, 1430, 2050, 1580, 1820];
const batchWithImages = 3;
const skusNeedingImages = ["SKU-10482", "SKU-10497", "SKU-10513", "SKU-10520"];
const imageRenderDurations = [880, 1240, 760, 1030];

function productImages(sku: string, renderDuration: number) {
  return run("generate-product-images", {
    queuedFor: 72,
    machine: "medium-1x",
    payload: { sku, sizes: [320, 640, 1280] },
    output: { sku, images: 3 },
    tags: ["catalog-sync", sku],
    attempts: [
      attempt("cold", [
        runFunction([
          log.info(`Rendering 3 sizes for ${sku}`, { sku }),
          span("resize-and-upload", {
            duration: renderDuration,
            properties: { sku, sizes: [320, 640, 1280] },
          }),
        ]),
      ]),
    ],
  });
}

function productBatch(index: number, upsertDuration: number) {
  const offset = index * productsPerBatch;
  const generatesImages = index === batchWithImages;

  return run("process-product-batch", {
    queue: "catalog-sync",
    idempotencyKey: `${syncId}-batch-${index + 1}`,
    payload: { syncId, offset, limit: productsPerBatch },
    output: {
      upserted: productsPerBatch,
      skipped: 0,
      ...(generatesImages ? { imagesGenerated: skusNeedingImages.length } : {}),
    },
    tags: ["catalog-sync"],
    attempts: [
      attempt(index < 5 ? "cold" : "warm", [
        runFunction([
          log.info(`Processing products ${offset + 1}–${offset + productsPerBatch}`, {
            offset,
            limit: productsPerBatch,
          }),
          span("upsert-products", {
            duration: upsertDuration,
            properties: { table: "products", count: productsPerBatch },
          }),
          ...(generatesImages
            ? [
                batchTriggerAndWait(
                  "generate-product-images",
                  skusNeedingImages.map((sku, i) => productImages(sku, imageRenderDurations[i]))
                ),
                log.info("Generated images for 4 new products", { skus: skusNeedingImages }),
              ]
            : []),
        ]),
      ]),
    ],
  });
}

export const fanOut = buildRunPageScenario({
  seed: 2,
  triggeredAt: new Date("2026-10-06T03:00:00.412Z"),
  run: run("sync-product-catalog", {
    queuedFor: 142,
    machine: "small-2x",
    payload: { syncId, shop: "acme-store.myshopify.com", fullSync: true },
    output: { products: 1920, batches: 12, imagesGenerated: 4, searchIndexRebuilt: true },
    tags: ["catalog-sync"],
    metadata: { syncId, batchesCompleted: 12, batchesTotal: 12 },
    attempts: [
      attempt("cold", [
        runFunction([
          log.info("Syncing catalog from Shopify", { shop: "acme-store.myshopify.com" }),
          span("fetch-catalog", {}, [
            httpRequest(
              "GET",
              "https://acme-store.myshopify.com/admin/api/2025-07/products.json?limit=250",
              { at: 2, duration: 612 }
            ),
            log.info("Fetched 1,920 products across 8 pages", { products: 1920, pages: 8 }),
          ]),
          log.info("Processing 12 batches of 160 products", { batches: 12 }),
          batchTriggerAndWait(
            "process-product-batch",
            upsertDurations.map((duration, index) => productBatch(index, duration)),
            { concurrencyLimit: 5 }
          ),
          log.info("All batches processed, rebuilding the search index"),
          triggerAndWait(
            run("rebuild-search-index", {
              queuedFor: 64,
              machine: "medium-2x",
              payload: { index: "products", source: syncId },
              output: { indexed: 1920 },
              attempts: [
                attempt("warm", [
                  runFunction([
                    log.info("Indexing 1,920 products", { index: "products" }),
                    span("index-products", {
                      duration: 2140,
                      properties: { index: "products", documents: 1920 },
                    }),
                    triggerAndWait(
                      run("purge-cdn-cache", {
                        queuedFor: 58,
                        payload: { paths: ["/products/*", "/collections/*"] },
                        output: { purged: 2 },
                        attempts: [
                          attempt("warm", [
                            runFunction([
                              httpRequest("POST", "https://api.fastly.com/service/2xkR9/purge", {
                                duration: 318,
                              }),
                              log.info("Purged 2 paths", {
                                paths: ["/products/*", "/collections/*"],
                              }),
                            ]),
                          ]),
                        ],
                      })
                    ),
                  ]),
                ]),
              ],
            })
          ),
          log.info("Catalog sync complete", { products: 1920, batches: 12 }),
        ]),
      ]),
    ],
  }),
});
