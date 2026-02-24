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

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { cartToken?: string; prizeVariantId?: string | number; token?: string; shop?: string };
    const prizeVariantId = body.prizeVariantId != null ? String(body.prizeVariantId).trim() : undefined;
    const token = body.token != null ? String(body.token).trim() : "";

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

    const updatedToken = signToken({
      ticketId,
      email,
      ticketType: payload.ticketType,
      expireTime: payload.expireTime,
      reservedPrizes: buildReservedPrizesFromTicket(ticket),
    });

    if (!prizeVariantId) {
      return json({ success: true, token: updatedToken });
    }

    const now = new Date();

    const otherPending = await prisma.ticketCode.findFirst({
      where: {
        reservedPrizeId: prizeVariantId,
        reservationExpiresAt: { gt: now },
        id: { not: ticketId },
      },
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
