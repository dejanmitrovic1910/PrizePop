import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { sendPlatinumInfoEmail } from "../email.server";

const VALID_TICKET_TYPES = ["Golden", "Platinum"] as const;

function parseTicketType(value: string): (typeof VALID_TICKET_TYPES)[number] {
  const v = value.trim().toLowerCase();
  if (v === "platinum") return "Platinum";
  return "Golden";
}

const TICKET_STATUS_PAGE_SIZE = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const total = await prisma.ticketCode.count();
  const tickets = await prisma.ticketCode.findMany({
    orderBy: { createdAt: "desc" },
    take: TICKET_STATUS_PAGE_SIZE,
    select: {
      id: true,
      code: true,
      type: true,
      status: true,
      email: true,
      usedAt: true,
      createdAt: true,
    },
  });
  return { total, tickets };
};

type TicketRow = { code: string; type: string };

function parseCsvTicketRows(text: string): TicketRow[] {
  const rows: TicketRow[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const defaultType = "Golden";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Handle optional quoted fields: "code","type" or code,type
    const parts: string[] = [];
    let pos = 0;
    while (pos < line.length) {
      if (line[pos] === '"') {
        let end = line.indexOf('"', pos + 1);
        while (end !== -1 && line[end + 1] === '"') {
          end = line.indexOf('"', end + 2);
        }
        if (end === -1) end = line.length;
        parts.push(line.slice(pos + 1, end).replace(/""/g, '"'));
        pos = end + 1;
        if (line[pos] === ",") pos++;
      } else {
        const comma = line.indexOf(",", pos);
        const sliceEnd = comma === -1 ? line.length : comma;
        parts.push(line.slice(pos, sliceEnd).trim());
        pos = comma === -1 ? line.length : comma + 1;
      }
    }

    const code = parts[0]?.trim() ?? "";
    const type = (parts[1]?.trim() || defaultType).slice(0, 255);
    if (code) rows.push({ code: code.slice(0, 500), type });
  }

  return rows;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  if (request.method !== "POST") {
    return { ok: false, error: "Method not allowed", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null as PlatinumDeliverResult | null };
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "").trim();

  // ——— Platinum info deliver ———
  if (intent === "platinum_deliver") {
    const token = String(formData.get("token") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();

    if (!token) {
      return { ok: false, error: "Ticket code is required.", platinumDeliver: { success: false, error: "Ticket code is required." }, imported: 0, skipped: 0, errors: [] };
    }
    if (!email) {
      return { ok: false, error: "Email is required.", platinumDeliver: { success: false, error: "Email is required." }, imported: 0, skipped: 0, errors: [] };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { ok: false, error: "Please enter a valid email address.", platinumDeliver: { success: false, error: "Invalid email address." }, imported: 0, skipped: 0, errors: [] };
    }

    const ticket = await prisma.ticketCode.findUnique({
      where: { code: token },
    });
    if (!ticket) {
      return { ok: false, error: "Invalid ticket code.", platinumDeliver: { success: false, error: "Invalid ticket code." }, imported: 0, skipped: 0, errors: [] };
    }
    if (ticket.type !== "Platinum") {
      return { ok: false, error: "This ticket is not a Platinum ticket.", platinumDeliver: { success: false, error: "This ticket is not a Platinum ticket." }, imported: 0, skipped: 0, errors: [] };
    }

    const sendResult = await sendPlatinumInfoEmail(email);
    if (!sendResult.ok) {
      return { ok: false, error: sendResult.error ?? "Failed to send email.", platinumDeliver: { success: false, error: sendResult.error }, imported: 0, skipped: 0, errors: [] };
    }

    return { ok: true, platinumDeliver: { success: true }, imported: 0, skipped: 0, errors: [] };
  }

  // ——— CSV import ———
  const file = formData.get("csv") as File | null;
  if (!file || !(file instanceof File)) {
    return { ok: false, error: "No CSV file provided", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null };
  }

  const text = await file.text();
  const rows = parseCsvTicketRows(text);

  if (rows.length === 0) {
    return { ok: false, error: "CSV is empty or has no valid rows (need at least a code per line)", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null };
  }

  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      await prisma.ticketCode.upsert({
        where: { code: row.code },
        create: {
          code: row.code,
          type: parseTicketType(row.type),
          status: "ACTIVE",
        },
        update: {},
      });
      imported++;
    } catch (e) {
      skipped++;
      const msg = e instanceof Error ? e.message : String(e);
      if (errors.length < 20) errors.push(`"${row.code}": ${msg}`);
    }
  }

  return {
    ok: true,
    imported,
    skipped,
    total: rows.length,
    errors: errors.slice(0, 20),
    platinumDeliver: null,
  };
};

type PlatinumDeliverResult = { success: true } | { success: false; error: string };

function maskCode(code: string): string {
  if (code.length <= 6) return "****";
  return code.slice(0, 2) + "****" + code.slice(-2);
}

function maskEmail(email: string | null): string {
  if (!email) return "—";
  const i = email.indexOf("@");
  if (i <= 2) return "***@***";
  return email.slice(0, 2) + "***" + email.slice(i);
}

export default function TicketsImport() {
  const { total, tickets } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [file, setFile] = useState<File | null>(null);
  const lastHandledDataRef = useRef<typeof fetcher.data>(undefined);

  const data = fetcher.data;
  const isLoading =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const isPlatinumSubmit = data?.platinumDeliver != null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !data || data === lastHandledDataRef.current) return;
    lastHandledDataRef.current = data;
    if (data.platinumDeliver) {
      if (data.platinumDeliver.success) {
        shopify.toast?.show?.("Platinum info email sent.");
        revalidator.revalidate();
      } else {
        shopify.toast?.show?.(data.platinumDeliver.error ?? "Failed to send email.", { isError: true });
      }
      return;
    }
    if (data.ok && data.imported > 0) {
      shopify.toast?.show?.(`Imported ${data.imported} ticket code(s)`);
      revalidator.revalidate();
    }
    if (data.error && !data.platinumDeliver) {
      shopify.toast?.show?.(data.error, { isError: true });
    }
  }, [fetcher.state, data, shopify, revalidator]);

  const handleCsvSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) return;
    const formData = new FormData();
    formData.set("csv", file);
    fetcher.submit(formData, { method: "POST", encType: "multipart/form-data" });
  };

  const handlePlatinumSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    formData.set("intent", "platinum_deliver");
    fetcher.submit(formData, { method: "POST" });
  };

  return (
    <s-page heading="Import ticket codes">
      <s-section heading="Platinum info delivery">
        <s-paragraph>
          Enter a valid Platinum ticket code and the email address to send the platinum information to. The ticket code will be validated before sending.
        </s-paragraph>
        <form onSubmit={handlePlatinumSubmit}>
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="base">
              <label htmlFor="platinum-token">Ticket code (token)</label>
              <input
                id="platinum-token"
                name="token"
                type="text"
                required
                placeholder="Enter Platinum ticket code"
                style={{ padding: "8px", width: "100%", maxWidth: "320px" }}
              />
            </s-stack>
            <s-stack direction="block" gap="base">
              <label htmlFor="platinum-email">Deliver info to email</label>
              <input
                id="platinum-email"
                name="email"
                type="email"
                required
                placeholder="customer@example.com"
                style={{ padding: "8px", width: "100%", maxWidth: "320px" }}
              />
            </s-stack>
            <s-button
              type="submit"
              variant="primary"
              disabled={isLoading}
              {...(isLoading && isPlatinumSubmit ? { loading: true } : {})}
            >
              {isLoading && isPlatinumSubmit ? "Sending…" : "Send platinum info email"}
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading="Upload CSV">
        <s-paragraph>
          Upload a CSV file with ticket codes. Use a header row or one code per
          line. Optional second column: <strong>type</strong> (e.g.{" "}
          <code>code,type</code> or <code>&quot;code&quot;,&quot;type&quot;</code>
          ). Duplicate codes are skipped (existing rows are not updated).
        </s-paragraph>
        <form onSubmit={handleCsvSubmit}>
          <s-stack direction="block" gap="base">
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ padding: "8px" }}
            />
            <s-button
              type="submit"
              variant="primary"
              disabled={!file || isLoading}
              {...(isLoading ? { loading: true } : {})}
            >
              {isLoading ? "Importing…" : "Import CSV"}
            </s-button>
          </s-stack>
        </form>
      </s-section>

      {data && !data.platinumDeliver && (
        <s-section heading="Import result">
          {data.ok ? (
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Imported: <strong>{data.imported}</strong>
                {data.skipped > 0 && (
                  <> · Skipped (duplicates/errors): <strong>{data.skipped}</strong></>
                )}
                {data.total != null && (
                  <> · Total rows in file: <strong>{data.total}</strong></>
                )}
              </s-paragraph>
              {data.errors && data.errors.length > 0 && (
                <s-box
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <strong>Sample errors:</strong>
                  <ul style={{ margin: "8px 0 0", paddingLeft: "20px" }}>
                    {data.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </s-box>
              )}
            </s-stack>
          ) : (
            data.error ? <s-paragraph tone="critical">{data.error}</s-paragraph> : null
          )}
        </s-section>
      )}

      <s-section heading="Ticket status">
        <s-paragraph>
          Recent tickets (latest {tickets.length}). Code and email are partially masked.
        </s-paragraph>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "520px" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--p-color-border)", textAlign: "left" }}>
                <th style={{ padding: "8px 12px" }}>Code</th>
                <th style={{ padding: "8px 12px" }}>Type</th>
                <th style={{ padding: "8px 12px" }}>Status</th>
                <th style={{ padding: "8px 12px" }}>Email</th>
                <th style={{ padding: "8px 12px" }}>Used at</th>
                <th style={{ padding: "8px 12px" }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: "16px", color: "var(--p-color-text-subdued)" }}>
                    No tickets yet. Import a CSV to add ticket codes.
                  </td>
                </tr>
              ) : (
                tickets.map((t) => (
                  <tr key={t.id} style={{ borderBottom: "1px solid var(--p-color-border)" }}>
                    <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{maskCode(t.code)}</td>
                    <td style={{ padding: "8px 12px" }}>{t.type}</td>
                    <td style={{ padding: "8px 12px" }}>{t.status}</td>
                    <td style={{ padding: "8px 12px" }}>{maskEmail(t.email)}</td>
                    <td style={{ padding: "8px 12px" }}>{t.usedAt ? new Date(t.usedAt).toLocaleString() : "—"}</td>
                    <td style={{ padding: "8px 12px" }}>{new Date(t.createdAt).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </s-section>

      <s-section slot="aside" heading="Total ticket codes">
        <s-paragraph>
          Stored in database: <strong>{total}</strong>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
