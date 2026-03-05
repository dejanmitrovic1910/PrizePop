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
  myPrize?: string | null;
  exp?: number;
};

async function getReservedPrizes(now: Date) {
  const ticketsWithReservedPrize = await prisma.ticketCode.findMany({
    where: {
      reservedPrizeId: { not: null },
      OR: [
        { status: "DISABLED" },
        { reservationExpiresAt: { gt: now } },
      ],
    },
    select: {
      reservedPrizeId: true,
      status: true,
      reservationExpiresAt: true,
    },
  });

  return ticketsWithReservedPrize
    .filter((t): t is typeof t & { reservedPrizeId: string } => t.reservedPrizeId != null)
    .map((t) => ({
      prizeId: t.reservedPrizeId,
      status: t.status,
      reservationExpiresAt: (t.reservationExpiresAt ?? new Date(0)).toISOString(),
    }));
}

function signToken(payload: Omit<TokenPayload, "exp">) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: REDEEM_TOKEN_EXPIRY_SECONDS });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    const body = await request.json() as { token?: string };
    const token = body.token?.trim();

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

    // Clear expired reservations (same as redeem.$ and claim)
    await prisma.ticketCode.updateMany({
      where: {
        status: { not: "DISABLED" },
        reservationExpiresAt: { lt: now },
        usedAt: null,
        usedOrderId: null,
      },
      data: {
        email: null,
        expiresAt: null,
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

    // Check if the email session on the ticket is expired (expiresAt < now)
    if (ticket.expiresAt && ticket.expiresAt < now) {
      return json(
        { success: false, message: "Your token is expired." },
        { status: 200 }
      );
    }

    // Fetch fresh reserved prizes (they may have changed since token was issued)
    const reservedPrizes = await getReservedPrizes(now);

    const expireTime = ticket.expiresAt?.toISOString() ?? payload.expireTime;

    const newPayload: Omit<TokenPayload, "exp"> = {
      ticketId,
      email,
      ticketType: payload.ticketType,
      expireTime,
      reservedPrizes,
      myPrize: ticket.reservedPrizeId ?? null,
    };

    const newToken = signToken(newPayload);

    return json({
      success: true,
      message: "Token refreshed.",
      token: newToken,
      myPrize: ticket.reservedPrizeId ?? null,
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
