import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { verifyAndValidateRedeemToken } from "../redeem.server";
import { sendPlatinumInfoEmail } from "../email.server";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORM_TYPE_PLATINUM = "platinum_signup";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET") return json({ success: false, message: "Method not allowed." }, { status: 405 });
  return json(
    { success: false, message: "Use POST with form data: first_name, last_name, email, form_type, token." },
    { status: 405 }
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed." }, { status: 405 });
  }

  try {
    const formData = await request.formData();
    const first_name = String(formData.get("first_name") ?? "").trim();
    const last_name = String(formData.get("last_name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const form_type = String(formData.get("form_type") ?? "").trim();
    const token = String(formData.get("token") ?? "").trim();

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

    const { ticket } = validation;
    const ticketType = (ticket as { type?: string }).type;

    if (form_type !== FORM_TYPE_PLATINUM) {
      return json(
        { success: false, message: "Invalid form type." },
        { status: 400 }
      );
    }

    if (ticketType !== "Platinum") {
      return json(
        { success: false, message: "This ticket is not a Platinum ticket." },
        { status: 400 }
      );
    }

    if (!first_name) {
      return json(
        { success: false, message: "First name is required." },
        { status: 400 }
      );
    }

    if (!last_name) {
      return json(
        { success: false, message: "Last name is required." },
        { status: 400 }
      );
    }

    if (!email) {
      return json(
        { success: false, message: "Email is required." },
        { status: 400 }
      );
    }

    if (!EMAIL_REGEX.test(email)) {
      return json(
        { success: false, message: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const sendResult = await sendPlatinumInfoEmail({
      to: email,
      firstName: first_name,
      lastName: last_name,
    });

    if (!sendResult.ok) {
      // Gmail / Google password mismatch: clear session (logout) and tell client to re-authenticate
      if (sendResult.smtpAuthError) {
        const { payload } = validation;
        await prisma.ticketCode.update({
          where: { id: payload.ticketId },
          data: {
            email: null,
            expiresAt: null,
            reservedPrizeId: null,
            reservationExpiresAt: null,
          },
        });
        return json(
          {
            success: false,
            message: "Session expired. Please sign in again.",
            logout: true,
          },
          { status: 401 }
        );
      }
      return json(
        { success: false, message: sendResult.error ?? "Failed to send email." },
        { status: 500 }
      );
    }

    return json({
      success: true,
      message: "Platinum info email sent.",
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
