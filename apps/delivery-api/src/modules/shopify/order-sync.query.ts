import type { ShopifyAdminGraphqlRequest } from './admin-graphql.client.js';

export type BuildOrdersUpdatedSinceQueryInput = {
  after?: string | null;
  first: number;
  updatedSince: Date;
};

export function buildOrdersUpdatedSinceQuery(
  input: BuildOrdersUpdatedSinceQueryInput
): ShopifyAdminGraphqlRequest {
  return {
    query: ORDERS_UPDATED_SINCE_QUERY,
    variables: {
      after: input.after ?? null,
      first: input.first,
      query: `updated_at:>='${input.updatedSince.toISOString()}'`
    }
  };
}

export const ORDERS_UPDATED_SINCE_QUERY = `#graphql
  query CleverDeliveryOrdersUpdatedSince($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
        id
        legacyResourceId
        name
        phone
        displayFinancialStatus
        displayFulfillmentStatus
        createdAt
        processedAt
        updatedAt
        cancelledAt
        note
        customAttributes {
          key
          value
        }
        lineItems(first: 20) {
          nodes {
            title
            name
            variantTitle
            quantity
            sku
          }
        }
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        shippingAddress {
          name
          phone
          address1
          address2
          city
          province
          provinceCode
          zip
          countryCodeV2
          latitude
          longitude
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;
