import { z } from "zod";

export const FirstOrLastSchema = z
  .object({
    first: z.number().optional(),
    last: z.number().optional(),
  })
  .default({ first: 100 });

const objectWithId = z.object({
  id: z.string(),
});

export const ProductVariantSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  price: z.string().nullable(),
  product: objectWithId,
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  compareAtPrice: z.string().nullable(),
  fulfillmentService: objectWithId.nullable(),
  image: objectWithId.nullable(),
  inventoryQuantity: z.number().nullable(),
  requiresShipping: z.boolean().nullable(),
  position: z.number().nullable(),
  taxCode: z.string().nullable(),
  taxable: z.boolean().nullable(),
  weight: z.number().nullable(),
  weightUnit: z.string().nullable(),
});

export const SearchVariantsBodySchema = FirstOrLastSchema.and(
  z.object({
    filter: z
      .object({
        productIds: z.array(z.string()).optional(),
        skus: z.array(z.string()).optional(),
      })
      .optional(),
  })
);

export const SearchVariantsSuccessResponseSchema = z.object({
  count: z.number(),
  productVariants: z.array(ProductVariantSchema),
});
