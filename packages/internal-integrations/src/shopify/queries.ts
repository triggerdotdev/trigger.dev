import { gql } from "urql";

export const defaultFirst = 100;

export const searchProductVariantsQuery = gql`
  query SearchProductVariants($first: Int!, $filters: String) {
    productVariants(first: $first, query: $filters) {
      edges {
        node {
          id
          title
          createdAt
          updatedAt
          price
          product {
            id
            title
          }
          sku
          barcode
          compareAtPrice
          fulfillmentService {
            id
          }
          image {
            id
          }
          inventoryQuantity
          requiresShipping
          position
          taxCode
          taxable
          weight
          weightUnit
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const createProductVariantsQuery = gql`
  mutation productVariantCreate($input: ProductVariantInput!) {
    productVariantCreate(input: $input) {
      productVariant {
        id
        title
        createdAt
        updatedAt
        price
        product {
          id
          title
        }
        sku
        barcode
        compareAtPrice
        fulfillmentService {
          id
        }
        image {
          id
        }
        inventoryQuantity
        requiresShipping
        position
        taxCode
        taxable
        weight
        weightUnit
      }
      userErrors {
        field
        message
      }
    }
  }
`;
