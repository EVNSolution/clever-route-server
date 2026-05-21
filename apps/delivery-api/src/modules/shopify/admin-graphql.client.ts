export type ShopifyAdminGraphqlRequest = {
  query: string;
  variables?: Record<string, unknown>;
};

type ShopifyAdminGraphqlClientOptions = {
  accessToken: string;
  apiVersion: string;
  fetchImpl?: FetchLike;
  shopDomain: string;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type ShopifyGraphqlResponse<TData> = {
  data?: TData;
  errors?: Array<{ message?: unknown }>;
};

export class ShopifyAdminGraphqlClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: ShopifyAdminGraphqlClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<TData = unknown>(request: ShopifyAdminGraphqlRequest): Promise<TData> {
    const response = await this.fetchImpl(this.endpointUrl(), {
      body: JSON.stringify({
        query: request.query,
        variables: request.variables ?? {}
      }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.options.accessToken
      },
      method: 'POST'
    });

    const payload = (await readJson(response)) as ShopifyGraphqlResponse<TData>;
    if (!response.ok) {
      throw new Error(`Shopify Admin GraphQL HTTP error: ${response.status}`);
    }

    if (payload.errors !== undefined && payload.errors.length > 0) {
      const messages = payload.errors
        .map((error) => (typeof error.message === 'string' ? error.message : 'Unknown error'))
        .join('; ');
      throw new Error(`Shopify Admin GraphQL error: ${messages}`);
    }

    if (payload.data === undefined) {
      throw new Error('Shopify Admin GraphQL response missing data');
    }

    return payload.data;
  }

  private endpointUrl(): string {
    return `https://${normalizeShopDomain(this.options.shopDomain)}/admin/api/${this.options.apiVersion}/graphql.json`;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error('Shopify Admin GraphQL returned invalid JSON', { cause: error });
  }
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}
