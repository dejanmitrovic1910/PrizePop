import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../db.server";

const JWT_SECRET = process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";
const REDEEM_TOKEN_EXPIRY_SECONDS = 120 * 60; // 2 hours

// 🔐 VERIFY SHOPIFY APP PROXY SIGNATURE
function verifyProxySignature(url: URL) {
  const params = Object.fromEntries(url.searchParams.entries());

  const signature = params.signature;
  delete params.signature;

  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("");

  const generated = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET!)
    .update(sorted)
    .digest("hex");

  return generated === signature;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const url = new URL(request.url);

    // 🔒 1️⃣ VERIFY APP PROXY SIGNATURE
    if (!verifyProxySignature(url)) {
      return new Response("Invalid signature", { status: 403 });
    }

    // 📦 2️⃣ GET FORM DATA
    const formData = await request.formData();
    const code = String(formData.get("code") || "").trim();
    const email = String(formData.get("email") || "").trim();

    if (!code) {
      return json(
        { success: false, message: "Ticket code is required." },
        { status: 400 }
      );
    }

    if (!email) {
      return json(
        { success: false, message: "Email is required." },
        { status: 400 }
      );
    }

    const now = new Date();

    // 🧠 3️⃣ ATOMIC TRANSACTION
    const result = await prisma.$transaction(async (tx) => {
      // 3.0 Clear expired reservations (after 15 min): if ticket not used, remove email, expiresAt, reservedPrizeId, reservationExpiresAt
      await tx.ticketCode.updateMany({
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

      // 3.1 Find ticket
      const ticket = await tx.ticketCode.findUnique({
        where: { code },
      });

      if (!ticket) {
        throw new Error("Invalid ticket code.");
      }

      if (ticket.status !== "ACTIVE") {
        throw new Error("This ticket has already been used.");
      }

      // 3.2 Find available or expired-reserved prize
      // const prize = await tx.prize.findFirst({
      //   where: {
      //     OR: [
      //       { status: "AVAILABLE" },
      //       {
      //         status: "RESERVED",
      //         reservedUntil: { lt: now },
      //       },
      //     ],
      //   },
      //   orderBy: { id: "asc" },
      // });

      // if (!prize) {
      //   throw new Error("No prizes available at the moment.");
      // }

      const expiresAt = new Date(Date.now() + 120 * 60 * 1000);

      // 3.2b Clear all fields except code, type, status, createdAt on same-email ACTIVE rows
      await tx.ticketCode.updateMany({
        where: {
          email,
          status: "ACTIVE",
        },
        data: {
          email: null,
          usedAt: null,
          usedOrderId: null,
          expiresAt: null,
          reservedPrizeId: null,
          reservationExpiresAt: null,
        },
      });

      // 3.3 Update ticket (email + expiresAt for claim verification; ticket id used in token)
      const updatedTicket = await tx.ticketCode.update({
        where: { id: ticket.id },
        data: {
          expiresAt: expiresAt,
          email: email,
        },
      });

      // 3.4 Find all reserved prizes from the ticketCode table (active reservations only)
      const ticketsWithReservedPrize = await tx.ticketCode.findMany({
        where: {
          reservedPrizeId: { not: null },
          reservationExpiresAt: { gt: now },
        },
        select: {
          reservedPrizeId: true,
          status: true,
          reservationExpiresAt: true,
        },
      });

      const reservedPrizes: { prizeId: string; status: string; reservationExpiresAt: Date }[] =
        ticketsWithReservedPrize
          .filter((t): t is typeof t & { reservedPrizeId: string; reservationExpiresAt: Date } =>
            t.reservedPrizeId != null && t.reservationExpiresAt != null
          )
          .map((t) => ({
            prizeId: t.reservedPrizeId,
            status: t.status,
            reservationExpiresAt: t.reservationExpiresAt,
          }));

      return { ticket: updatedTicket, expiresAt, reservedPrizes };
    });

    // ✅ SUCCESS RESPONSE – payload for JWT (ticket id used for claim verification; never expose code on storefront)
    const expiresAt = result.expiresAt;
    const ticketType = result.ticket.type;
    const ticketId = result.ticket.id;
    const reservedPrizes = result.reservedPrizes;
    const payload = {
      success: true,
      message: "Ticket is valid, please select a prize.",
      ticketId, // ticket code id for claim verification
      ticketType,
      email,
      expireTime: expiresAt.toISOString(),
      reservedPrizes, // { prizeId, status }[] for frontend lock and out-of-stock prevention
    };
    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: REDEEM_TOKEN_EXPIRY_SECONDS,
    });

    return json({
      ...payload,
      token,
    });
  } catch (error: any) {
    return json(
      {
        success: false,
        message: error.message || "Something went wrong.",
      },
      { status: 400 }
    );
  }
};
