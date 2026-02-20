import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import jwt from "jsonwebtoken";
import prisma from "../db.server";

const JWT_SECRET = process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";
const RESERVATION_WINDOW_MS = 120 * 60 * 1000; // 2 hours

type TokenPayload = {
  ticketId: string;
  email: string;
  exp?: number;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    let body: { token?: string; prizeId?: string };
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      body = await request.json();
    } else {
      const formData = await request.formData();
      body = {
        token: String(formData.get("token") ?? "").trim(),
        prizeId: String(formData.get("prizeId") ?? "").trim(),
      };
    }

    const token = body.token?.trim();
    const prizeId = body.prizeId?.trim();

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
        { success: false, message: "Invalid or expired token." },
        { status: 401 }
      );
    }

    const { ticketId, email } = payload;
    if (!ticketId || !email) {
      return json(
        { success: false, message: "Invalid token payload." },
        { status: 401 }
      );
    }

    const now = new Date();

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
      return json(
        { success: false, message: "Ticket and email do not match." },
        { status: 403 }
      );
    }

    // Already sold (used)
    if (ticket.usedAt ?? ticket.usedOrderId) {
      return json(
        { success: false, message: "This ticket has already been used." },
        { status: 400 }
      );
    }

    // Already in cart: reserved by this or another session and not expired
    if (ticket.reservedPrizeId && ticket.reservationExpiresAt && ticket.reservationExpiresAt > now) {
      return json(
        { success: false, message: "This product is already in cart or reserved." },
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
