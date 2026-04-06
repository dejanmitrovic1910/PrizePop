/**
 * Creates Shopify discount codes for Golden tickets and aligns shipping discount settings.
 * Requires Admin API scopes: read_discounts, write_discounts (and collection read via read_products / write_products).
 */

const DEFAULT_GOLDEN_COLLECTION_TITLE = "GOLDEN PRIZE COLLECTION FOR TEST";

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<Response>;
};

async function readGraphqlData<T>(response: Response): Promise<T> {
  const json = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) {
    throw new Error("Empty GraphQL response");
  }
  return json.data;
}

function goldenCollectionTitle(): string {
  return (
    process.env.GOLDEN_PRIZE_COLLECTION_TITLE?.trim() ||
    DEFAULT_GOLDEN_COLLECTION_TITLE
  );
}

function shippingDiscountCode(): string | null {
  const c = process.env.PRIZEPOP_SHIPPING_DISCOUNT_CODE?.trim();
  return c || null;
}

export async function findGoldenPrizeCollectionGid(
  admin: AdminGraphql
): Promise<string> {
  const title = goldenCollectionTitle();
  const query = `title:\"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\"`;
  const gql = `#graphql
    query GoldenCollection($q: String!) {
      collections(first: 5, query: $q) {
        nodes {
          id
          title
        }
      }
    }
  `;
  const data = await readGraphqlData<{
    collections: { nodes: { id: string; title: string }[] };
  }>(await admin.graphql(gql, { variables: { q: query } }));

  const exact = data.collections.nodes.find(
    (n) => n.title.trim().toLowerCase() === title.toLowerCase()
  );
  if (!exact) {
    throw new Error(
      `Collection "${title}" was not found in Shopify. Create it or set GOLDEN_PRIZE_COLLECTION_TITLE.`
    );
  }
  return exact.id;
}

export async function createGoldenTicketCollectionDiscount(
  admin: AdminGraphql,
  params: { shopifyCode: string }
): Promise<void> {
  const collectionGid = await findGoldenPrizeCollectionGid(admin);
  const startsAt = new Date().toISOString();
  const title = `Golden ticket — ${params.shopifyCode}`.slice(0, 255);

  const gql = `#graphql
    mutation CreateGoldenDiscount($basic: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basic) {
        codeDiscountNode {
          id
        }
        userErrors {
          field
          code
          message
        }
      }
    }
  `;

  const basicCodeDiscount = {
    title,
    code: params.shopifyCode,
    startsAt,
    endsAt: null,
    context: { all: "ALL" },
    customerGets: {
      value: { percentage: 1 },
      items: {
        collections: { add: [collectionGid] },
      },
    },
    usageLimit: 1,
    appliesOncePerCustomer: false,
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: true,
    },
  };

  const data = await readGraphqlData<{
    discountCodeBasicCreate: {
      userErrors: { field: string[] | null; code: string | null; message: string }[];
    };
  }>(await admin.graphql(gql, { variables: { basic: basicCodeDiscount } }));

  const errs = data.discountCodeBasicCreate.userErrors;
  if (errs?.length) {
    throw new Error(errs.map((e) => e.message).join("; "));
  }
}

/**
 * Sets the store's free-shipping discount (by customer-facing code) to a single total redemption
 * and allows combining with product (Golden collection) discounts.
 */
export async function ensureShippingDiscountSingleUseCombinesWithProduct(
  admin: AdminGraphql
): Promise<void> {
  const code = shippingDiscountCode();
  if (!code) return;

  const lookupGql = `#graphql
    query ShippingDiscountByCode($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        codeDiscount {
          __typename
          ... on DiscountCodeFreeShipping {
            id
          }
        }
      }
    }
  `;

  const lookedUp = await readGraphqlData<{
    codeDiscountNodeByCode: {
      codeDiscount:
        | { __typename: string; id?: string }
        | null;
    } | null;
  }>(await admin.graphql(lookupGql, { variables: { code } }));

  const node = lookedUp.codeDiscountNodeByCode;
  const discount = node?.codeDiscount;
  if (!discount || discount.__typename !== "DiscountCodeFreeShipping" || !discount.id) {
    throw new Error(
      `PRIZEPOP_SHIPPING_DISCOUNT_CODE "${code}" must be an existing free shipping discount code.`
    );
  }

  const updateGql = `#graphql
    mutation UpdateShippingDiscount(
      $id: ID!
      $input: DiscountCodeFreeShippingInput!
    ) {
      discountCodeFreeShippingUpdate(id: $id, freeShippingCodeDiscount: $input) {
        codeDiscountNode {
          id
        }
        userErrors {
          field
          code
          message
        }
      }
    }
  `;

  const freeShippingCodeDiscount = {
    usageLimit: 1,
    appliesOncePerCustomer: false,
    combinesWith: {
      productDiscounts: true,
      orderDiscounts: false,
      shippingDiscounts: false,
    },
  };

  const updated = await readGraphqlData<{
    discountCodeFreeShippingUpdate: {
      userErrors: { message: string }[];
    };
  }>(
    await admin.graphql(updateGql, {
      variables: { id: discount.id, input: freeShippingCodeDiscount },
    })
  );

  const uErrs = updated.discountCodeFreeShippingUpdate.userErrors;
  if (uErrs?.length) {
    throw new Error(uErrs.map((e) => e.message).join("; "));
  }
}

export async function setupDiscountsForNewGoldenTicket(
  admin: AdminGraphql,
  ticketCode: string
): Promise<void> {
  const shopifyCode = ticketCode.trim().slice(0, 255);
  if (!shopifyCode) {
    throw new Error("Ticket code is empty.");
  }
  await ensureShippingDiscountSingleUseCombinesWithProduct(admin);
  await createGoldenTicketCollectionDiscount(admin, { shopifyCode });
}
