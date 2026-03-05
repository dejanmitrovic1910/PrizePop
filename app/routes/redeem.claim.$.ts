import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { scheduleReleaseAfter15Min } from "../release-timer.server";
import {
  verifyAndValidateRedeemToken,
  clearExpiredReservations,
  getReservedPrizes,
  buildTokenPayloadFromTicket,
  signRedeemToken,
} from "../redeem.server";

const RESERVATION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { token?: string; variant_id?: string };
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

    const validation = await verifyAndValidateRedeemToken(token);
    if (!validation.ok) {
      return json(
        { success: false, message: validation.message },
        { status: 401 }
      );
    }

    const { payload, ticket } = validation;
    const now = new Date();

    await clearExpiredReservations();

    const reservedPrizesOthers = await getReservedPrizes(now, payload.ticketId);
    const refreshedToken = () =>
      signRedeemToken(buildTokenPayloadFromTicket(payload, ticket, reservedPrizesOthers));

    if (ticket.usedAt ?? ticket.usedOrderId) {
      return json(
        {
          success: false,
          message: "This ticket has already been used.",
          token: refreshedToken(),
        },
        { status: 400 }
      );
    }

    const inCart = await prisma.ticketCode.findFirst({
      where: {
        reservedPrizeId: prizeId,
        reservationExpiresAt: { gt: now },
        id: { not: payload.ticketId },
      },
    });
    if (inCart) {
      return json(
        {
          success: false,
          message: "This product is already in someone else's cart.",
          token: refreshedToken(),
        },
        { status: 400 }
      );
    }

    const alreadySold = await prisma.ticketCode.findFirst({
      where: {
        reservedPrizeId: prizeId,
        usedAt: { not: null },
      },
    });
    if (alreadySold) {
      return json(
        {
          success: false,
          message: "This product has already been sold.",
          token: refreshedToken(),
        },
        { status: 400 }
      );
    }

    const reservationExpiresAt = new Date(Date.now() + RESERVATION_WINDOW_MS);

    const updated = await prisma.ticketCode.update({
      where: { id: payload.ticketId },
      data: {
        reservedPrizeId: prizeId,
        reservationExpiresAt,
      },
    });

    scheduleReleaseAfter15Min(payload.ticketId, prizeId);

    const tokenPayload = buildTokenPayloadFromTicket(
      payload,
      updated as typeof ticket,
      reservedPrizesOthers
    );

    return json({
      success: true,
      message: "Successfully added to cart.",
      token: signRedeemToken(tokenPayload),
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
