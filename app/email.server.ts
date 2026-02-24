/**
 * Send email via Resend API (no extra dependency).
 * Set RESEND_API_KEY in .env. Optional: RESEND_FROM (e.g. "PrizePop <onboarding@resend.dev>").
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM ?? "PrizePop <onboarding@resend.dev>";

export async function sendPlatinumInfoEmail(to: string): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY?.trim()) {
    return { ok: false, error: "Email is not configured. Set RESEND_API_KEY in environment." };
  }

  const subject = "Got Platinum Ticket Information";
  const html = `
    <h2>Platinum Ticket Information</h2>
    <p>Thank you for your interest. This email confirms your Platinum ticket details.</p>
    <p>If you have any questions, please contact support.</p>
    <p>— PrizePop Team</p>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        html,
      }),
    });

    const data = (await res.json()) as { id?: string; message?: string };
    if (!res.ok) {
      const msg = data?.message ?? `Resend API error: ${res.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
