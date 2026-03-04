import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../db.server";

const JWT_SECRET = process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";

const PRIZE_TOKEN_PROP = "_prize_token";

type TokenPayload = {
  ticketId: string;
  email: string;
  ticketType?: string;
  expireTime?: string;
  reservedPrizes?: { prizeId: string; status: string; reservationExpiresAt: string }[];
  exp?: number;
};

/** Shopify order payload (webhook sends snake_case). */
type ShopifyOrder = {
  id?: string | number;
  line_items?: Array<{
    variant_id?: string | number;
    properties?: Array<{ name?: string; value?: string }>;
  }>;
};

/**
 * Verify Shopify webhook HMAC.
 * - App-registered webhooks: signed with SHOPIFY_API_SECRET.
 * - Admin-created webhooks (Settings > Notifications > Webhooks): signed with the
 *   "Signing secret" shown there — set WEBHOOK_SIGNING_SECRET to that value.
 */
function verifyShopifyHmac(rawBody: string, hmacHeader: string | null): boolean {
  const header = hmacHeader?.trim();
  if (!header) return false;

  const secrets: string[] = [];
  if (process.env.SHOPIFY_API_SECRET) {
    secrets.push(process.env.SHOPIFY_API_SECRET);
  }
  if (process.env.WEBHOOK_SIGNING_SECRET) {
    secrets.push(process.env.WEBHOOK_SIGNING_SECRET);
  }
  if (secrets.length === 0) return false;

  const bodyBuffer = Buffer.from(rawBody, "utf8");
  for (const secret of secrets) {
    const computed = crypto
      .createHmac("sha256", secret)
      .update(bodyBuffer)
      .digest("base64");
    try {
      if (
        header.length === computed.length &&
        crypto.timingSafeEqual(Buffer.from(header, "base64"), Buffer.from(computed, "base64"))
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function getPrizeTokenFromLineItem(
  lineItem: { properties?: Array<{ name?: string; value?: string }> }
): string | null {
  const props = lineItem.properties ?? [];
  const found = props.find((p) => (p.name ?? "").trim() === PRIZE_TOKEN_PROP);
  return found?.value?.trim() ?? null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const rawBody = await request.text();
    const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      return json({ error: "Invalid webhook signature" }, { status: 401 });
    }

    const order = JSON.parse(rawBody) as ShopifyOrder;
    const lineItems = order.line_items ?? [];
    const orderId = order.id != null ? String(order.id) : null;

    if (!orderId) {
      return json({ error: "Order ID missing" }, { status: 400 });
    }

    const itemsWithToken: { token: string; variantId: string }[] = [];
    for (const item of lineItems) {
      const token = getPrizeTokenFromLineItem(item);
      if (!token) continue;
      const variantId = item.variant_id != null ? String(item.variant_id) : null;
      if (variantId) {
        itemsWithToken.push({ token, variantId });
      }
    }

    if (itemsWithToken.length === 0) {
      return new Response(null, { status: 200 });
    }

    const now = new Date();
    const updatedTicketIds = new Set<string>();

    for (const { token, variantId } of itemsWithToken) {
      let payload: TokenPayload;
      try {
        payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
      } catch {
        continue;
      }

      const { ticketId, email } = payload;
      if (!ticketId || !email) continue;
      if (updatedTicketIds.has(ticketId)) continue;

      const ticket = await prisma.ticketCode.findUnique({
        where: { id: ticketId },
      });

      if (!ticket) continue;
      if (ticket.usedAt ?? ticket.usedOrderId) continue;

      updatedTicketIds.add(ticketId);
      await prisma.ticketCode.update({
        where: { id: ticketId },
        data: {
          status: "DISABLED",
          email,
          usedOrderId: orderId,
          reservedPrizeId: variantId,
          usedAt: now,
        },
      });
    }

    return new Response(null, { status: 200 });
  } catch (error: unknown) {
    return json(
      { error: error instanceof Error ? error.message : "Something went wrong" },
      { status: 500 }
    );
  }
};
