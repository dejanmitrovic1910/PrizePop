import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import jwt from "jsonwebtoken";
import prisma from "../db.server";

const JWT_SECRET = process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";

type TokenPayload = {
  ticketId: string;
  email?: string;
  exp?: number;
};

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

    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
      return json(
        { success: false, message: "Invalid or expired token." },
        { status: 403 }
      );
    }

    const { ticketId } = payload;
    if (!ticketId) {
      return json(
        { success: false, message: "Invalid or expired token." },
        { status: 403 }
      );
    }

    const ticket = await prisma.ticketCode.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      return json(
        { success: false, message: "Invalid or expired token." },
        { status: 403 }
      );
    }

    await prisma.ticketCode.update({
      where: { id: ticketId },
      data: {
        email: null,
        expiresAt: null,
        reservedPrizeId: null,
        reservationExpiresAt: null,
      },
    });

    return json({ success: true, message: "Logged out." });
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
