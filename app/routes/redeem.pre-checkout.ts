import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  verifyAndValidateRedeemToken,
  buildReservedPrizesFromTicket,
  buildTokenPayloadFromTicket,
  signRedeemToken,
} from "../redeem.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    const body = (await request.json()) as {
      cartToken?: string;
      prizeVariantId?: string | number;
      token?: string;
      shop?: string;
    };
    const prizeVariantId =
      body.prizeVariantId != null ? String(body.prizeVariantId).trim() : undefined;
    const token = body.token != null ? String(body.token).trim() : "";

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
        { status: 403 }
      );
    }

    const { payload, ticket } = validation;

    const updatedToken = signRedeemToken(
      buildTokenPayloadFromTicket(
        payload,
        ticket,
        buildReservedPrizesFromTicket(ticket)
      )
    );

    if (!prizeVariantId) {
      return json({ success: true, token: updatedToken });
    }

    const now = new Date();

    const otherPending = await prisma.ticketCode.findFirst({
      where: {
        reservedPrizeId: prizeVariantId,
        reservationExpiresAt: { gt: now },
        id: { not: payload.ticketId },
      },
    });

    if (otherPending) {
      return json(
        {
          success: false,
          message:
            "A prize in your cart is already in another customer's pending checkout.",
          token: updatedToken,
        },
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
