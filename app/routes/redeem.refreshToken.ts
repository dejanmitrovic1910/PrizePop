import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import {
  verifyAndValidateRedeemToken,
  clearExpiredReservations,
  getReservedPrizes,
  buildTokenPayloadFromTicket,
  signRedeemToken,
} from "../redeem.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { token?: string };
    const token = body.token?.trim();

    if (!token) {
      return json(
        { success: false, message: "Token is required." },
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

    const reservedPrizes = await getReservedPrizes(now, ticket.id);
    const newPayload = buildTokenPayloadFromTicket(payload, ticket, reservedPrizes);
    const newToken = signRedeemToken(newPayload);

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
