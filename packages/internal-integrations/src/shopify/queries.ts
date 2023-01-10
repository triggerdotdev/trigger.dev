import { gql } from "urql";

export const searchProductVariantsQuery = gql`
  query SearchProductVariants($first: Int = 100, $filters: String) {
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
