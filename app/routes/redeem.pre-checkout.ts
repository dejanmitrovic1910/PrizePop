import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import jwt from "jsonwebtoken";
import prisma from "../db.server";

const JWT_SECRET = process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";
const REDEEM_TOKEN_EXPIRY_SECONDS = 120 * 60; // 2 hours (match redeem.$.ts)
const STOREFRONT_API_VERSION = "2024-01";

type TokenPayload = {
  ticketId: string;
  email: string;
  ticketType?: string;
  expireTime?: string;
  reservedPrizes?: { prizeId: string; status: string; reservationExpiresAt: string }[];
  exp?: number;
};

function buildReservedPrizesFromTicket(ticket: {
  reservedPrizeId: string | null;
  status: string;
  reservationExpiresAt: Date | null;
}) {
  const reservedPrizes: { prizeId: string; status: string; reservationExpiresAt: string }[] = [];
  if (ticket.reservedPrizeId && ticket.reservationExpiresAt) {
    reservedPrizes.push({
      prizeId: ticket.reservedPrizeId,
      status: ticket.status,
      reservationExpiresAt: ticket.reservationExpiresAt.toISOString(),
    });
  }
  return reservedPrizes;
}

function signToken(payload: Omit<TokenPayload, "exp">) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: REDEEM_TOKEN_EXPIRY_SECONDS });
}

async function getCartPrizeVariantIds(cartToken: string, shop: string, storefrontAccessToken: string): Promise<string[]> {
  const url = `https://${shop}/api/${STOREFRONT_API_VERSION}/graphql.json`;
  const query = `
    query getCart($cartId: ID!) {
      cart(id: $cartId) {
        id
        lines(first: 100) {
          nodes {
            merchandise {
              ... on ProductVariant {
                id
                product {
                  tags
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": storefrontAccessToken,
    },
    body: JSON.stringify({
      query,
      variables: { cartId: cartToken },
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to fetch cart");
  }

  const data = (await response.json()) as {
    data?: { cart?: { lines?: { nodes?: Array<{ merchandise?: { id?: string; product?: { tags?: string[] } } }> } } };
    errors?: Array<{ message?: string }>;
  };

  if (data.errors?.length) {
    throw new Error(data.errors[0]?.message ?? "Cart query failed");
  }

  const nodes = data.data?.cart?.lines?.nodes ?? [];
  const prizeVariantIds: string[] = [];

  for (const node of nodes) {
    const merchandise = node.merchandise as { id?: string; product?: { tags?: string[] } } | undefined;
    if (!merchandise?.id || !merchandise.product?.tags) continue;
    const hasPrizeTag = merchandise.product.tags.some((t: string) => t.toLowerCase() === "prize");
    if (hasPrizeTag) {
      prizeVariantIds.push(merchandise.id);
    }
  }

  return prizeVariantIds;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { cartToken?: string; token?: string; shop?: string };
    const cartToken = body.cartToken?.trim();
    const token = body.token?.trim();

    if (!cartToken) {
      return json(
        { success: false, message: "Cart token is required." },
        { status: 400 }
      );
    }

    if (!token) {
      return json(
        { success: false, message: "Token is required." },
        { status: 400 }
      );
    }

    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
      return json(
        { success: false, message: "Invalid or expired token." },
        { status: 403 }
      );
    }

    const { ticketId, email } = payload;
    if (!ticketId || !email) {
      return json(
        { success: false, message: "Invalid or expired token." },
        { status: 403 }
      );
    }

    const ticket = await prisma.ticketCode.findUnique({
      where: { id: ticketId },
    });

    if (!ticket || ticket.email !== email) {
      return json(
        { success: false, message: "Invalid or expired token." },
        { status: 403 }
      );
    }

    const shop = body.shop?.trim() || process.env.SHOPIFY_STORE_DOMAIN;
    const storefrontAccessToken = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;

    if (!shop || !storefrontAccessToken) {
      return json(
        { success: false, message: "Server configuration error." },
        { status: 500 }
      );
    }

    const prizeVariantIds = await getCartPrizeVariantIds(cartToken, shop, storefrontAccessToken);

    if (prizeVariantIds.length === 0) {
      const updatedToken = signToken({
        ticketId,
        email,
        ticketType: payload.ticketType,
        expireTime: payload.expireTime,
        reservedPrizes: buildReservedPrizesFromTicket(ticket),
      });
      return json({ success: true, token: updatedToken });
    }

    const now = new Date();

    const otherPending = await prisma.ticketCode.findFirst({
      where: {
        reservedPrizeId: { in: prizeVariantIds },
        reservationExpiresAt: { gt: now },
        id: { not: ticketId },
      },
    });

    const updatedToken = signToken({
      ticketId,
      email,
      ticketType: payload.ticketType,
      expireTime: payload.expireTime,
      reservedPrizes: buildReservedPrizesFromTicket(ticket),
    });

    if (otherPending) {
      return json(
        { success: false, message: "A prize in your cart is already in another customer's pending checkout.", token: updatedToken },
        { status: 200 }
      );
    }

    return json({ success: true, token: updatedToken });
  } catch (error: unknown) {
    return json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Something went wrong.",
      },
      { status: 400 }
    );
  }
};
