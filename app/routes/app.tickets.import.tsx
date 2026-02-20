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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const total = await prisma.ticketCode.count();
  return { total };
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
    return { ok: false, error: "Method not allowed", imported: 0, skipped: 0, errors: [] as string[] };
  }

  const formData = await request.formData();
  const file = formData.get("csv") as File | null;

  if (!file || !(file instanceof File)) {
    return { ok: false, error: "No CSV file provided", imported: 0, skipped: 0, errors: [] as string[] };
  }

  const text = await file.text();
  const rows = parseCsvTicketRows(text);

  if (rows.length === 0) {
    return { ok: false, error: "CSV is empty or has no valid rows (need at least a code per line)", imported: 0, skipped: 0, errors: [] as string[] };
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
          type: row.type,
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
  };
};

export default function TicketsImport() {
  const { total } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [file, setFile] = useState<File | null>(null);
  const lastHandledDataRef = useRef<typeof fetcher.data>(undefined);

  const data = fetcher.data;
  const isLoading =
    fetcher.state === "submitting" || fetcher.state === "loading";

  useEffect(() => {
    if (fetcher.state !== "idle" || !data || data === lastHandledDataRef.current) return;
    lastHandledDataRef.current = data;
    if (data.ok && data.imported > 0) {
      shopify.toast?.show?.(`Imported ${data.imported} ticket code(s)`);
      revalidator.revalidate();
    }
    if (data.error) {
      shopify.toast?.show?.(data.error, { isError: true });
    }
  }, [fetcher.state, data, shopify, revalidator]);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) return;
    const formData = new FormData();
    formData.set("csv", file);
    fetcher.submit(formData, { method: "POST", encType: "multipart/form-data" });
  };

  return (
    <s-page heading="Import ticket codes">
      <s-section heading="Upload CSV">
        <s-paragraph>
          Upload a CSV file with ticket codes. Use a header row or one code per
          line. Optional second column: <strong>type</strong> (e.g.{" "}
          <code>code,type</code> or <code>&quot;code&quot;,&quot;type&quot;</code>
          ). Duplicate codes are skipped (existing rows are not updated).
        </s-paragraph>
        <form onSubmit={handleSubmit}>
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

      {data && (
        <s-section heading="Result">
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
                  <s-text fontWeight="bold">Sample errors:</s-text>
                  <ul style={{ margin: "8px 0 0", paddingLeft: "20px" }}>
                    {data.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </s-box>
              )}
            </s-stack>
          ) : (
            <s-paragraph tone="critical">{data.error}</s-paragraph>
          )}
        </s-section>
      )}

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
