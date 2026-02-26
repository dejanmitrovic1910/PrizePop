import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { type Prisma } from "@prisma/client";
import prisma from "../db.server";
import { sendPlatinumInfoEmail } from "../email.server";
import { TicketsTable, type TicketRow } from "../components/TicketsTable";
import { EditTicketModal } from "../components/EditTicketModal";
import { AddTicketModal } from "../components/AddTicketModal";

const VALID_TICKET_TYPES = ["Golden", "Platinum"] as const;

function parseTicketType(value: string): (typeof VALID_TICKET_TYPES)[number] {
  const v = value.trim().toLowerCase();
  if (v === "platinum") return "Platinum";
  return "Golden";
}

const TICKET_STATUS_PAGE_SIZE = 10;

const SORT_OPTIONS = [
  { value: "createdAt_desc", label: "Created (newest first)" },
  { value: "createdAt_asc", label: "Created (oldest first)" },
  { value: "code_asc", label: "Code (A–Z)" },
  { value: "code_desc", label: "Code (Z–A)" },
  { value: "type_asc", label: "Type (A–Z)" },
  { value: "type_desc", label: "Type (Z–A)" },
  { value: "status_asc", label: "Status (A–Z)" },
  { value: "status_desc", label: "Status (Z–A)" },
  { value: "usedAt_desc", label: "Used at (newest first)" },
  { value: "usedAt_asc", label: "Used at (oldest first)" },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const filterType = url.searchParams.get("type")?.trim() ?? "all";
  const filterStatus = url.searchParams.get("status")?.trim() ?? "all";
  const sortParam = url.searchParams.get("sort")?.trim() ?? "createdAt_desc";

  const where: Prisma.TicketCodeWhereInput = {};
  if (search) {
    where.OR = [
      { code: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }
  if (filterType !== "all" && (filterType === "Golden" || filterType === "Platinum")) {
    where.type = filterType;
  }
  if (filterStatus !== "all") {
    where.status = filterStatus;
  }

  const orderBy: Prisma.TicketCodeOrderByWithRelationInput =
    sortParam === "code_asc" ? { code: "asc" } :
    sortParam === "code_desc" ? { code: "desc" } :
    sortParam === "type_asc" ? { type: "asc" } :
    sortParam === "type_desc" ? { type: "desc" } :
    sortParam === "status_asc" ? { status: "asc" } :
    sortParam === "status_desc" ? { status: "desc" } :
    sortParam === "createdAt_asc" ? { createdAt: "asc" } :
    sortParam === "usedAt_desc" ? { usedAt: "desc" } :
    sortParam === "usedAt_asc" ? { usedAt: "asc" } :
    { createdAt: "desc" };

  const [total, tickets] = await Promise.all([
    prisma.ticketCode.count({ where }),
    prisma.ticketCode.findMany({
        where,
        orderBy,
        skip: (page - 1) * TICKET_STATUS_PAGE_SIZE,
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
      }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / TICKET_STATUS_PAGE_SIZE));
  return {
    total,
    tickets,
    page,
    totalPages,
    search,
    filterType,
    filterStatus,
    sort: sortParam,
    sortOptions: SORT_OPTIONS,
  };
};

type CsvTicketRow = { code: string; type: string };

function parseCsvTicketRows(text: string): CsvTicketRow[] {
  const rows: CsvTicketRow[] = [];
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

  // ——— Ticket add ———
  if (intent === "ticket_add") {
    const code = String(formData.get("code") ?? "").trim().slice(0, 500);
    const typeRaw = String(formData.get("type") ?? "Golden").trim();
    const type = typeRaw === "Platinum" ? "Platinum" : "Golden";
    if (!code) {
      return { ok: false, error: "Code is required.", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_add", success: false, error: "Code is required." } };
    }
    const existing = await prisma.ticketCode.findUnique({ where: { code } });
    if (existing) {
      return { ok: false, error: "A ticket with this code already exists.", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_add", success: false, error: "Code already exists." } };
    }
    await prisma.ticketCode.create({
      data: { code, type, status: "ACTIVE" },
    });
    return { ok: true, imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_add", success: true } };
  }

  // ——— Ticket edit ———
  if (intent === "ticket_edit") {
    const id = String(formData.get("id") ?? "").trim();
    const code = String(formData.get("code") ?? "").trim().slice(0, 500);
    const typeRaw = String(formData.get("type") ?? "").trim();
    const statusVal = String(formData.get("status") ?? "").trim();
    if (!id) {
      return { ok: false, error: "Ticket ID is required.", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_edit", success: false, error: "ID required." } };
    }
    const existing = await prisma.ticketCode.findUnique({ where: { id } });
    if (!existing) {
      return { ok: false, error: "Ticket not found.", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_edit", success: false, error: "Ticket not found." } };
    }
    const updates: { code?: string; type?: "Golden" | "Platinum"; status?: string } = {};
    if (code && code !== existing.code) {
      const duplicate = await prisma.ticketCode.findUnique({ where: { code } });
      if (duplicate) {
        return { ok: false, error: "Another ticket already has this code.", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_edit", success: false, error: "Code already in use." } };
      }
      updates.code = code;
    } else if (code) updates.code = code;
    if (typeRaw === "Platinum" || typeRaw === "Golden") updates.type = typeRaw;
    if (["ACTIVE", "RESERVED", "DISABLED", "ACTIVATE"].includes(statusVal)) updates.status = statusVal;
    if (Object.keys(updates).length === 0) {
      return { ok: true, imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_edit", success: true } };
    }
    await prisma.ticketCode.update({ where: { id }, data: updates });
    return { ok: true, imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_edit", success: true } };
  }

  // ——— Ticket remove ———
  if (intent === "ticket_remove") {
    const id = String(formData.get("id") ?? "").trim();
    if (!id) {
      return { ok: false, error: "Ticket ID is required.", imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_remove", success: false, error: "ID required." } };
    }
    await prisma.ticketCode.delete({ where: { id } }).catch(() => null);
    return { ok: true, imported: 0, skipped: 0, errors: [] as string[], platinumDeliver: null, ticketAction: { intent: "ticket_remove", success: true } };
  }

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
  const skippedCodes: string[] = [];
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const existing = await prisma.ticketCode.findUnique({
        where: { code: row.code },
      });
      if (existing) {
        skipped++;
        if (skippedCodes.length < 50) skippedCodes.push(row.code);
        continue;
      }
      await prisma.ticketCode.create({
        data: {
          code: row.code,
          type: parseTicketType(row.type),
          status: "ACTIVE",
        },
      });
      imported++;
    } catch (e) {
      skipped++;
      const msg = e instanceof Error ? e.message : String(e);
      if (errors.length < 20) errors.push(`"${row.code}": ${msg}`);
      if (skippedCodes.length < 50) skippedCodes.push(row.code);
    }
  }

  return {
    ok: true,
    imported,
    skipped,
    skippedCodes: skippedCodes.slice(0, 50),
    total: rows.length,
    errors: errors.slice(0, 20),
    platinumDeliver: null,
  };
};

type PlatinumDeliverResult = { success: true } | { success: false; error: string };

export default function TicketsImport() {
  const { total, tickets, page, totalPages, search, filterType, filterStatus, sort } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [file, setFile] = useState<File | null>(null);
  const lastHandledDataRef = useRef<typeof fetcher.data>(undefined);
  const [searchInputValue, setSearchInputValue] = useState(search);
  const [editingTicket, setEditingTicket] = useState<TicketRow | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const editModalRef = useRef<HTMLElement & { showOverlay?: () => void; hideOverlay?: () => void }>(null);
  const addModalRef = useRef<HTMLElement & { showOverlay?: () => void; hideOverlay?: () => void }>(null);

  // Keep search input in sync with URL when loader search changes
  useEffect(() => {
    setSearchInputValue(search);
  }, [search]);

  // Show edit modal when editingTicket is set
  useEffect(() => {
    if (editingTicket) {
      editModalRef.current?.showOverlay?.();
    }
  }, [editingTicket]);

  const handleRefresh = () => {
    revalidator.revalidate();
    navigate(location.pathname + (searchParams.toString() ? "?" + searchParams.toString() : ""), { replace: true });
  };

  const handleSearchSubmit = () => {
    updateTableParams({ search: searchInputValue });
  };

  const data = fetcher.data;
  const isLoading =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const isPlatinumSubmit = data?.platinumDeliver != null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !data || data === lastHandledDataRef.current) return;
    lastHandledDataRef.current = data;
    const ticketAction = (data as { ticketAction?: { intent: string; success: boolean; error?: string } })?.ticketAction;
    if (ticketAction) {
      if (ticketAction.success) {
        const msg = ticketAction.intent === "ticket_add" ? "Ticket added." : ticketAction.intent === "ticket_edit" ? "Ticket updated." : "Ticket removed.";
        shopify.toast?.show?.(msg);
        revalidator.revalidate();
      } else {
        shopify.toast?.show?.(ticketAction.error ?? "Action failed.", { isError: true });
      }
      return;
    }
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
      setFile(null);
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

  const handleAddTicket = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    formData.set("intent", "ticket_add");
    fetcher.submit(formData, { method: "POST" });
    form.reset();
    addModalRef.current?.hideOverlay?.();
    setShowAddModal(false);
  };

  const handleEditTicket = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    formData.set("intent", "ticket_edit");
    formData.set("id", editingTicket!.id);
    fetcher.submit(formData, { method: "POST" });
    editModalRef.current?.hideOverlay?.();
    setEditingTicket(null);
  };

  const handleRemoveTicket = (t: TicketRow) => {
    if (!confirm(`Remove ticket "${t.code}"? This cannot be undone.`)) return;
    const formData = new FormData();
    formData.set("intent", "ticket_remove");
    formData.set("id", t.id);
    fetcher.submit(formData, { method: "POST" });
  };

  const updateTableParams = (updates: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([k, v]) => {
      if (v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    });
    next.set("page", "1");
    setSearchParams(next);
  };

  const setPage = (p: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(Math.max(1, Math.min(p, totalPages))));
    setSearchParams(next);
  };

  return (
    <s-page heading="Import ticket codes">
      {/* <s-section heading="Platinum info delivery">
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
      </s-section> */}

      <s-section heading="Upload CSV">
        <s-paragraph>
          Upload a CSV file with ticket codes. Use a header row or one code per
          line. Optional second column: <strong>type</strong> (e.g.{" "}
          <code>code,type</code> or <code>&quot;code&quot;,&quot;type&quot;</code>
          ). Duplicate codes are skipped (existing rows are not updated).
        </s-paragraph>
        <form onSubmit={handleCsvSubmit}>
          <s-stack direction="block" gap="base">
            <s-drop-zone
              label="Drop CSV file to upload"
              accessibilityLabel="Upload CSV file with ticket codes"
              accept=".csv,text/csv,text/plain"
              name="csv"
              value=""
              onInput={(e: { currentTarget?: { files?: File[] } }) => {
                const files = e.currentTarget?.files;
                if (files?.length) setFile(files[0]);
              }}
              onChange={(e: { currentTarget?: { files?: File[] } }) => {
                const files = e.currentTarget?.files;
                if (files?.length) setFile(files[0]);
              }}
            />
            {file && (
              <span style={{ color: "var(--p-color-text-subdued)", fontSize: "14px" }}>
                Selected: {file.name}
              </span>
            )}
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
                {data.skipped != null && data.skipped > 0 && (
                  <> · Skipped (duplicates/errors): <strong>{data.skipped}</strong></>
                )}
                {data.total != null && (
                  <> · Total rows in file: <strong>{data.total}</strong></>
                )}
              </s-paragraph>
              {data.skippedCodes && data.skippedCodes.length > 0 && (
                <s-box
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <strong>Skipped codes (not imported):</strong>
                  <p style={{ margin: "6px 0 0", fontFamily: "monospace", fontSize: "13px" }}>
                    {data.skippedCodes.join(", ")}
                    {data.skipped != null && data.skipped > data.skippedCodes.length && (
                      <> … and {data.skipped - data.skippedCodes.length} more</>
                    )}
                  </p>
                </s-box>
              )}
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
          Total ticket codes in DB: <strong>{total}</strong>
          {total > 0 && (
            <> · Showing <strong>{tickets.length}</strong> on this page</>
          )}
        </s-paragraph>

        <TicketsTable
          tickets={tickets}
          total={total}
          page={page}
          totalPages={totalPages}
          search={search}
          searchInputValue={searchInputValue}
          onSearchInputChange={setSearchInputValue}
          onSearchSubmit={handleSearchSubmit}
          filterType={filterType}
          filterStatus={filterStatus}
          onFilterChange={(updates) => updateTableParams(updates)}
          sort={sort}
          onSortChange={(sortValue) => updateTableParams({ sort: sortValue })}
          onPageChange={setPage}
          onEdit={setEditingTicket}
          onRemove={handleRemoveTicket}
          onRefresh={handleRefresh}
          onAddTicketClick={() => setShowAddModal(true)}
          isLoading={isLoading}
        />
      </s-section>

      <EditTicketModal
        ref={editModalRef}
        ticket={editingTicket}
        onClose={() => setEditingTicket(null)}
        onSubmit={handleEditTicket}
        isLoading={isLoading}
      />
      <AddTicketModal
        ref={addModalRef}
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSubmit={handleAddTicket}
        isLoading={isLoading}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
