import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../db.server";

const JWT_SECRET = process.env.SHOPIFY_API_SECRET ?? process.env.JWT_SECRET ?? "fallback-secret";
const REDEEM_TOKEN_EXPIRY_SECONDS = 10 * 60; // 10 minutes

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

    if (!code) {
      return json(
        { success: false, message: "Ticket code is required." },
        { status: 400 }
      );
    }

    const now = new Date();

    // 🧠 3️⃣ ATOMIC TRANSACTION
    const result = await prisma.$transaction(async (tx) => {
      // 3.1 Find ticket
      const ticket = await tx.ticketCode.findUnique({
        where: { code },
      });

      if (!ticket) {
        throw new Error("Invalid ticket code.");
      }

      if (ticket.status !== "ACTIVE") {
        throw new Error("This ticket has already been used or reserved.");
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

      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      // 3.3 Reserve prize
      // await tx.prize.update({
      //   where: { id: prize.id },
      //   data: {
      //     status: "RESERVED",
      //     reservedUntil: expiresAt,
      //   },
      // });

      // 3.4 Update ticket
      // await tx.ticketCode.update({
      //   where: { id: ticket.id },
      //   data: {
      //     status: "RESERVED",
      //     reservedPrizeId: prize.id,
      //     reservationExpiresAt: expiresAt,
      //   },
      // });

      // 3.5 Extract numeric variant ID
      // const numericVariantId =
      //   prize.shopifyVariantId.split("/").pop() ?? prize.shopifyVariantId;

      // return {
      //   variantId: numericVariantId,
      // };
      return { ticket, expiresAt };
    });

    // ✅ SUCCESS RESPONSE – payload for JWT
    const expiresAt = result.expiresAt;
    const ticketType = result.ticket.type;
    const payload = {
      success: true,
      message: "Ticket is valid, please select a prize.",
      ticketType,
      expireTime: expiresAt.toISOString(),
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
