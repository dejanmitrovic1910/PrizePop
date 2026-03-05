import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { clearReleaseTimer } from "../release-timer.server";
import {
  verifyAndValidateRedeemToken,
  getReservedPrizes,
  buildTokenPayloadFromTicket,
  signRedeemToken,
} from "../redeem.server";

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
    const body = (await request.json()) as { token?: string; variantId?: string | number };
    const token = body.token != null ? String(body.token).trim() : undefined;
    const prizeId = body.variantId != null ? String(body.variantId).trim() : undefined;

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

    const validation = await verifyAndValidateRedeemToken(token);
    if (!validation.ok) {
      return json(
        { success: false, message: validation.message },
        { status: 401 }
      );
    }

    const { payload, ticket } = validation;

    let ticketForToken = ticket;
    if (ticket.reservedPrizeId === prizeId) {
      clearReleaseTimer(ticket.id);
      const updated = await prisma.ticketCode.update({
        where: { id: ticket.id },
        data: {
          reservedPrizeId: null,
          reservationExpiresAt: null,
        },
      });
      ticketForToken = updated as typeof ticket;
    }

    const now = new Date();
    const reservedPrizesOthers = await getReservedPrizes(now, ticketForToken.id);
    const newPayload = buildTokenPayloadFromTicket(
      payload,
      ticketForToken,
      reservedPrizesOthers
    );
    const newToken = signRedeemToken(newPayload);

    return json({
      success: true,
      message: "Reservation released.",
      token: newToken,
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
