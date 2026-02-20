import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import jwt from "jsonwebtoken";
import prisma from "../db.server";

const JWT_SECRET = process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";
const REDEEM_TOKEN_EXPIRY_SECONDS = 120 * 60; // 2 hours (match redeem.$.ts)
const RESERVATION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes – reservation is liberated after this

type TokenPayload = {
  ticketId: string;
  email: string;
  ticketType?: string;
  expireTime?: string;
  reservedPrizes?: { prizeId: string; status: string; reservationExpiresAt: string }[];
  exp?: number;
};

function buildReservedPrizesFromTicket(ticket: { reservedPrizeId: string | null; status: string; reservationExpiresAt: Date | null }) {
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

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    let body: { token?: string; variant_id?: string };
    body = await request.json();
    

    const token = body.token?.trim();
    const prizeId = body.variant_id?.trim();

    if (!token) {
      return json(
        { success: false, message: "Token is required." },
        { status: 400 }
      );
    }

    if (!prizeId) {
      return json(
        { success: false, message: "Prize ID is required." },
        { status: 400 }
      );
    }

    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
      return json(
        { success: false, message: "Invalid token." },
        { status: 401 }
      );
    }

    const { ticketId, email } = payload;
    const now = new Date();
    if (!ticketId || !email) {
      return json(
        { success: false, message: "Invalid or expired token." },
        { status: 401 }
      );
    }

    // Clear expired reservations (after 15 min): if status is not DISABLED, remove reservedPrizeId and reservationExpiresAt
    await prisma.ticketCode.updateMany({
      where: {
        status: { not: "DISABLED" },
        reservationExpiresAt: { lt: now },
      },
      data: {
        reservedPrizeId: null,
        reservationExpiresAt: null,
      },
    });

    const ticket = await prisma.ticketCode.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      return json(
        { success: false, message: "Ticket not found." },
        { status: 404 }
      );
    }

    if (ticket.email !== email) {
      const updatedToken = signToken({
        ticketId,
        email,
        ticketType: payload.ticketType,
        expireTime: payload.expireTime,
        reservedPrizes: buildReservedPrizesFromTicket(ticket),
      });
      return json(
        { success: false, message: "Ticket and email do not match.", token: updatedToken },
        { status: 403 }
      );
    }

    if (ticket.usedAt ?? ticket.usedOrderId) {
      const updatedToken = signToken({
        ticketId,
        email,
        ticketType: payload.ticketType,
        expireTime: payload.expireTime,
        reservedPrizes: buildReservedPrizesFromTicket(ticket),
      });
      return json(
        { success: false, message: "This ticket has already been used.", token: updatedToken },
        { status: 400 }
      );
    }

    const inCart = await prisma.ticketCode.findFirst({
      where: {
        reservedPrizeId: prizeId,
        reservationExpiresAt: { gt: now },
      },
    });
    if (inCart) {
      const updatedToken = signToken({
        ticketId,
        email,
        ticketType: payload.ticketType,
        expireTime: payload.expireTime,
        reservedPrizes: buildReservedPrizesFromTicket(ticket),
      });
      return json(
        { success: false, message: "This product is already in a cart.", token: updatedToken },
        { status: 400 }
      );
    }

    // Whole table: is this prize already sold (any ticket used with this prize)?
    const alreadySold = await prisma.ticketCode.findFirst({
      where: {
        reservedPrizeId: prizeId,
        usedAt: { not: null },
      },
    });
    if (alreadySold) {
      const updatedToken = signToken({
        ticketId,
        email,
        ticketType: payload.ticketType,
        expireTime: payload.expireTime,
        reservedPrizes: buildReservedPrizesFromTicket(ticket),
      });
      return json(
        { success: false, message: "This product has already been sold.", token: updatedToken },
        { status: 400 }
      );
    }

    const reservationExpiresAt = new Date(Date.now() + RESERVATION_WINDOW_MS);

    await prisma.ticketCode.update({
      where: { id: ticketId },
      data: {
        reservedPrizeId: prizeId,
        reservationExpiresAt,
      },
    });

    return json({
      success: true,
      message: "Successfully added to cart.",
    });
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
