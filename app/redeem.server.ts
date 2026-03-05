import jwt from "jsonwebtoken";
import prisma from "./db.server";

export const REDEEM_TOKEN_EXPIRY_SECONDS = 120 * 60; // 2 hours
const JWT_SECRET =
  process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";

export type TokenPayload = {
  ticketId: string;
  email: string;
  ticketType?: string;
  expireTime?: string;
  reservedPrizes?: {
    prizeId: string;
    status: string;
    reservationExpiresAt: string;
  }[];
  myPrize?: string | null;
  exp?: number;
};

export type TicketWithRedeemFields = {
  id: string;
  email: string | null;
  expiresAt: Date | null;
  status: string;
  reservedPrizeId: string | null;
  reservationExpiresAt: Date | null;
  usedAt: Date | null;
  usedOrderId: string | null;
};

const INVALID_OR_EXPIRED_MESSAGE = "Your token is invalid or expired";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Verifies the JWT and validates that the ticket exists, has the same email as the token,
 * and the ticket's email session is not expired. Use this on all token-based redeem endpoints.
 */
export async function verifyAndValidateRedeemToken(
  token: string
): Promise<
  | { ok: true; payload: TokenPayload; ticket: TicketWithRedeemFields }
  | { ok: false; message: string }
> {
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return { ok: false, message: INVALID_OR_EXPIRED_MESSAGE };
  }

  const { ticketId, email } = payload;
  if (!ticketId || !email) {
    return { ok: false, message: INVALID_OR_EXPIRED_MESSAGE };
  }

  const ticket = await prisma.ticketCode.findUnique({
    where: { id: ticketId },
  });

  if (!ticket) {
    return { ok: false, message: INVALID_OR_EXPIRED_MESSAGE };
  }

  // Ticket must have an email bound (session exists)
  if (!ticket.email || !ticket.email.trim()) {
    return { ok: false, message: INVALID_OR_EXPIRED_MESSAGE };
  }

  // Ticket's email session must not be expired
  const now = new Date();
  if (!ticket.expiresAt || ticket.expiresAt < now) {
    return { ok: false, message: INVALID_OR_EXPIRED_MESSAGE };
  }

  // Token email must match ticket email
  if (normalizeEmail(ticket.email) !== normalizeEmail(email)) {
    return { ok: false, message: INVALID_OR_EXPIRED_MESSAGE };
  }

  return {
    ok: true,
    payload,
    ticket: ticket as TicketWithRedeemFields,
  };
}

/**
 * Signs a new redeem token. Include the returned token in every success response.
 */
export function signRedeemToken(
  payload: Omit<TokenPayload, "exp">
): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: REDEEM_TOKEN_EXPIRY_SECONDS,
  });
}

/**
 * Clears expired reservations (email, expiresAt, reservedPrizeId, reservationExpiresAt)
 * for tickets that are not used and past reservation window.
 */
export async function clearExpiredReservations(): Promise<void> {
  const now = new Date();
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
}

/**
 * Build reservedPrizes array from a single ticket (for token payload).
 */
export function buildReservedPrizesFromTicket(ticket: {
  reservedPrizeId: string | null;
  status: string;
  reservationExpiresAt: Date | null;
}): { prizeId: string; status: string; reservationExpiresAt: string }[] {
  if (!ticket.reservedPrizeId || !ticket.reservationExpiresAt) return [];
  return [
    {
      prizeId: ticket.reservedPrizeId,
      status: ticket.status,
      reservationExpiresAt: ticket.reservationExpiresAt.toISOString(),
    },
  ];
}

/**
 * Fetches all currently reserved prizes (for refreshToken / full list).
 */
export async function getReservedPrizes(now: Date = new Date()) {
  const rows = await prisma.ticketCode.findMany({
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
  return rows
    .filter((t): t is typeof t & { reservedPrizeId: string } => t.reservedPrizeId != null)
    .map((t) => ({
      prizeId: t.reservedPrizeId,
      status: t.status,
      reservationExpiresAt: (t.reservationExpiresAt ?? new Date(0)).toISOString(),
    }));
}

/**
 * Builds token payload for refresh from current payload + ticket (for success responses).
 */
export function buildTokenPayloadFromTicket(
  payload: TokenPayload,
  ticket: TicketWithRedeemFields,
  reservedPrizes?: { prizeId: string; status: string; reservationExpiresAt: string }[]
): Omit<TokenPayload, "exp"> {
  const expireTime = ticket.expiresAt?.toISOString() ?? payload.expireTime;
  const list =
    reservedPrizes ?? buildReservedPrizesFromTicket(ticket);
  return {
    ticketId: payload.ticketId,
    email: payload.email,
    ticketType: payload.ticketType,
    expireTime,
    reservedPrizes: list,
    myPrize: ticket.reservedPrizeId ?? null,
  };
}
