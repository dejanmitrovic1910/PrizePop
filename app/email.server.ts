/**
 * Send email via Google SMTP.
 * Set in .env: GOOGLE_EMAIL (e.g. your@gmail.com), GOOGLE_EMAIL_PASSWORD (app password).
 * Optional: SMTP_FROM_NAME (e.g. "PrizePop") for the From display name.
 */

import nodemailer from "nodemailer";

const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL?.trim();
const GOOGLE_EMAIL_PASSWORD = process.env.GOOGLE_EMAIL_PASSWORD?.trim();
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME ?? "PrizePop";

function getTransporter() {
  if (!GOOGLE_EMAIL || !GOOGLE_EMAIL_PASSWORD) {
    return null;
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: GOOGLE_EMAIL,
      pass: GOOGLE_EMAIL_PASSWORD,
    },
  });
}

export type SendPlatinumInfoEmailParams = {
  to: string;
  firstName: string;
  lastName: string;
};

export async function sendPlatinumInfoEmail(
  params: SendPlatinumInfoEmailParams
): Promise<{ ok: boolean; error?: string }> {
  const { to, firstName, lastName } = params;
  const transporter = getTransporter();

  if (!transporter) {
    return {
      ok: false,
      error:
        "Email is not configured. Set GOOGLE_EMAIL and GOOGLE_EMAIL_PASSWORD in environment.",
    };
  }

  const subject = "Got Platinum Ticket Information";
  const html = `
    <h2>Platinum Ticket Information</h2>
    <p>Hi ${escapeHtml(firstName)} ${escapeHtml(lastName)},</p>
    <p>Thank you for your interest. This email confirms your Platinum ticket details.</p>
    <p>If you have any questions, please contact support.</p>
    <p>— ${escapeHtml(SMTP_FROM_NAME)} Team</p>
  `;

  try {
    await transporter.sendMail({
      from: `"${SMTP_FROM_NAME}" <${GOOGLE_EMAIL}>`,
      to,
      subject,
      html,
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (ch) => map[ch] ?? ch);
}
