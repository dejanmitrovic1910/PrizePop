/**
 * Creates Shopify discount codes for Golden tickets only: 100% off the prize collection + free shipping.
 * Requires Admin API scopes: read_discounts, write_discounts (and collection read via write_products).
 */

const DEFAULT_PRIZE_COLLECTION_TITLE = "GOLDEN PRIZE COLLECTION FOR TEST";

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

function prizeCollectionTitle(): string {
  return (
    process.env.GOLDEN_PRIZE_COLLECTION_TITLE?.trim() ||
    DEFAULT_PRIZE_COLLECTION_TITLE
  );
}

/** Customer-facing shipping code: must differ from the ticket code and be Shopify-safe. */
function shippingCheckoutCode(ticketCode: string): string {
  const t = ticketCode.trim();
  const raw = `SHIP-${t}`.replace(/\s+/g, "-");
  const sanitized = raw
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const code = sanitized.slice(0, 255);
  if (code.length < 4) {
    throw new Error(
      "Ticket code must include enough letters or numbers to build a shipping discount code (SHIP-…)."
    );
  }
  return code;
}

export async function findPrizeCollectionGid(admin: AdminGraphql): Promise<string> {
  const title = prizeCollectionTitle();
  const query = `title:\"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\"`;
  const gql = `#graphql
    query PrizeCollection($q: String!) {
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

async function createTicketCollectionDiscount(
  admin: AdminGraphql,
  params: { productCode: string }
): Promise<void> {
  const collectionGid = await findPrizeCollectionGid(admin);
  const startsAt = new Date().toISOString();
  const title = `Ticket — ${params.productCode}`.slice(0, 255);

  const gql = `#graphql
    mutation CreateTicketCollectionDiscount($basic: DiscountCodeBasicInput!) {
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
    code: params.productCode,
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

async function createTicketFreeShippingDiscount(
  admin: AdminGraphql,
  params: { ticketCode: string; shippingCode: string }
): Promise<void> {
  const startsAt = new Date().toISOString();
  const title = `Shipping code ${params.ticketCode}`.slice(0, 255);

  const gql = `#graphql
    mutation CreateTicketFreeShipping($fs: DiscountCodeFreeShippingInput!) {
      discountCodeFreeShippingCreate(freeShippingCodeDiscount: $fs) {
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
    title,
    code: params.shippingCode,
    startsAt,
    endsAt: null,
    context: { all: "ALL" },
    destination: { all: true },
    usageLimit: 1,
    appliesOncePerCustomer: false,
    combinesWith: {
      productDiscounts: true,
      orderDiscounts: false,
      shippingDiscounts: false,
    },
  };

  const data = await readGraphqlData<{
    discountCodeFreeShippingCreate: {
      userErrors: { message: string }[];
    };
  }>(await admin.graphql(gql, { variables: { fs: freeShippingCodeDiscount } }));

  const errs = data.discountCodeFreeShippingCreate.userErrors;
  if (errs?.length) {
    throw new Error(errs.map((e) => e.message).join("; "));
  }
}

/**
 * Creates two single-use codes for a Golden ticket: 100% off the prize collection (code = ticket code) and
 * free shipping (checkout code SHIP-… derived from the ticket code; admin title "Shipping code {ticket}").
 */
export async function setupDiscountsForNewTicket(
  admin: AdminGraphql,
  ticketCode: string
): Promise<void> {
  const productCode = ticketCode.trim().slice(0, 255);
  if (!productCode) {
    throw new Error("Ticket code is empty.");
  }
  const shippingCode = shippingCheckoutCode(productCode);
  if (shippingCode.toLowerCase() === productCode.toLowerCase()) {
    throw new Error("Shipping discount code would collide with the ticket code; use a different ticket code.");
  }

  await createTicketCollectionDiscount(admin, { productCode });
  await createTicketFreeShippingDiscount(admin, {
    ticketCode: productCode,
    shippingCode,
  });
}
