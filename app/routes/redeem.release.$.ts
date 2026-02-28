import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import jwt from "jsonwebtoken";
import prisma from "../db.server";

const JWT_SECRET = process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";
const REDEEM_TOKEN_EXPIRY_SECONDS = 120 * 60; // 2 hours (match redeem.$.ts)

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

/**
 * Called when the user removes the prize from the cart.
 * Clears reservedPrizeId and reservationExpiresAt for this ticket so the
 * 15-minute reservation is released and the prize can be selected again.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { token?: string; variantId?: string };
    const token = body.token?.trim();
    const prizeId = body.variantId?.trim();

    if (!token) {
      return json(
        { success: false, message: "Token is required." },
        { status: 400 }
      );
    }

    if (!prizeId) {
      return json(
        { success: false, message: "Variant ID (prize) is required." },
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

    const { ticketId } = payload;
    if (!ticketId) {
      return json(
        { success: false, message: "Invalid or expired token." },
        { status: 401 }
      );
    }

    const ticket = await prisma.ticketCode.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      return json(
        { success: false, message: "Ticket not found." },
        { status: 404 }
      );
    }

    let ticketForToken = ticket;
    // Only clear if this ticket currently has this prize reserved (stop the 15-min counting)
    if (ticket.reservedPrizeId === prizeId) {
      ticketForToken = await prisma.ticketCode.update({
        where: { id: ticketId },
        data: {
          reservedPrizeId: null,
          reservationExpiresAt: null,
        },
      });
    }

    const updatedToken = signToken({
      ticketId,
      email: payload.email,
      ticketType: payload.ticketType,
      expireTime: payload.expireTime,
      reservedPrizes: buildReservedPrizesFromTicket(ticketForToken),
    });

    return json({
      success: true,
      message: "Reservation released.",
      token: updatedToken,
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
