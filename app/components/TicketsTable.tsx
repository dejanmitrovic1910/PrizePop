import { useState, useEffect } from "react";

export type TicketRow = {
  id: string;
  code: string;
  type: string;
  status: string;
  email: string | null;
  usedAt: string | Date | null;
  createdAt: string | Date;
};

export type SortOption = { value: string; label: string };

const SORTABLE_COLUMNS = [
  { key: "code", label: "Code" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "usedAt", label: "Used at" },
  { key: "createdAt", label: "Created" },
] as const;

export interface TicketsTableProps {
  tickets: TicketRow[];
  total: number;
  page: number;
  totalPages: number;
  search: string;
  searchInputValue: string;
  onSearchInputChange: (value: string) => void;
  onSearchSubmit: () => void;
  filterType: string;
  filterStatus: string;
  onFilterChange: (updates: { type?: string; status?: string }) => void;
  sort: string;
  onSortChange: (sort: string) => void;
  onPageChange: (page: number) => void;
  onEdit: (ticket: TicketRow) => void;
  onRemove: (ticket: TicketRow) => void;
  onRefresh: () => void;
  onAddTicketClick: () => void;
  isLoading?: boolean;
}

function StatusBadge({ status }: { status: string }) {
  const isActive = status === "ACTIVE";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "13px",
      }}
    >
      <span
        style={{
          padding: "2px 8px",
          borderRadius: "9999px",
          fontWeight: 500,
          backgroundColor: isActive
            ? "var(--p-color-bg-fill-success-secondary, #d3f0d4)"
            : "var(--p-color-bg-fill-secondary, #f1f1f1)",
          color: isActive
            ? "var(--p-color-text-success, #008060)"
            : "var(--p-color-text-subdued, #6d7175)",
        }}
      >
        {status}
      </span>
    </span>
  );
}

export function TicketsTable({
  tickets,
  total,
  page,
  totalPages,
  search,
  searchInputValue,
  onSearchInputChange,
  onSearchSubmit,
  filterType,
  filterStatus,
  onFilterChange,
  sort,
  onSortChange,
  onPageChange,
  onEdit,
  onRemove,
  onRefresh,
  onAddTicketClick,
  isLoading = false,
}: TicketsTableProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);

  useEffect(() => {
    if (search) setSearchExpanded(true);
  }, [search]);

  const getNextSort = (columnKey: string) =>
    sort === `${columnKey}_asc` ? `${columnKey}_desc` : `${columnKey}_asc`;
  const isSortedBy = (columnKey: string) => sort.startsWith(columnKey + "_");
  const sortDirection = (columnKey: string) =>
    sort === `${columnKey}_desc` ? "desc" : "asc";

  return (
    <s-box
      padding="none"
      borderWidth="base"
      borderRadius="large"
      background="surface"
      style={{ overflow: "hidden" }}
    >
      {/* Filter bar — slightly darker background */}
      <div
        style={{
          padding: "16px 20px",
          backgroundColor: "var(--p-color-bg-surface-secondary, #f6f6f7)",
          borderBottom: "1px solid var(--p-color-border, #e1e3e5)",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        {/* Row 1: Type, Status (not full width) + search icon, refresh, Add ticket */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
            <s-select
              label="Type"
              labelAccessibilityVisibility="exclusive"
              value={filterType}
              onInput={(e) =>
                onFilterChange({
                  type: (e.target as HTMLSelectElement & { value: string }).value,
                })
              }
            >
              <s-option value="all">All types</s-option>
              <s-option value="Golden">Golden</s-option>
              <s-option value="Platinum">Platinum</s-option>
            </s-select>
            <s-select
              label="Status"
              labelAccessibilityVisibility="exclusive"
              value={filterStatus}
              onInput={(e) =>
                onFilterChange({
                  status: (e.target as HTMLSelectElement & { value: string }).value,
                })
              }
            >
              <s-option value="all">All statuses</s-option>
              <s-option value="ACTIVE">ACTIVE</s-option>
              <s-option value="RESERVED">RESERVED</s-option>
              <s-option value="DISABLED">DISABLED</s-option>
              <s-option value="ACTIVATE">ACTIVATE</s-option>
            </s-select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto" }}>
            <s-button
              variant="tertiary"
              icon="search"
              onClick={() => setSearchExpanded((v) => !v)}
              aria-label={searchExpanded ? "Hide search" : "Show search"}
            />
            <s-button
              variant="tertiary"
              icon="refresh"
              onClick={onRefresh}
              aria-label="Refresh table"
            />
            <s-button variant="primary" onClick={onAddTicketClick}>
              Add ticket
            </s-button>
          </div>
        </div>
        {/* Row 2: Search field + Search button — full width when expanded */}
        {searchExpanded && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSearchSubmit();
            }}
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: "12px",
              width: "100%",
            }}
          >
            <div style={{ flex: "1 1 0", minWidth: 0 }}>
              <s-search-field
                label="Search"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by code or email…"
                value={searchInputValue}
                onInput={(e) =>
                  onSearchInputChange(
                    (e.target as HTMLInputElement & { value: string }).value
                  )
                }
              />
            </div>
            <s-button variant="primary" type="submit">
              Search
            </s-button>
          </form>
        )}
      </div>

      {/* Table */}
      <s-section padding="none">
        <s-table>
          <s-table-header-row>
            {SORTABLE_COLUMNS.map(({ key, label }) => (
              <s-table-header key={key} listSlot="labeled">
                <button
                  type="button"
                  onClick={() => onSortChange(getNextSort(key))}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    font: "inherit",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: 0,
                  }}
                  title={`Sort by ${label}`}
                >
                  {label}
                  {isSortedBy(key) && (
                    <span aria-hidden>
                      {sortDirection(key) === "asc" ? " ↑" : " ↓"}
                    </span>
                  )}
                </button>
              </s-table-header>
            ))}
            <s-table-header listSlot="labeled">Email</s-table-header>
            <s-table-header listSlot="inline">Action</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {tickets.length === 0 ? (
              <s-table-row>
                <s-table-cell>
                  <span
                    style={{
                      display: "block",
                      textAlign: "center",
                      padding: "24px",
                      color: "var(--p-color-text-subdued)",
                    }}
                  >
                    {search || filterType !== "all" || filterStatus !== "all"
                      ? "No tickets match the current filters."
                      : "No tickets yet. Import a CSV or add a ticket above."}
                  </span>
                </s-table-cell>
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
              </s-table-row>
            ) : (
              tickets.map((t) => (
                <s-table-row key={t.id}>
                  <s-table-cell>
                    <span style={{ fontFamily: "monospace" }}>{t.code}</span>
                  </s-table-cell>
                  <s-table-cell>{t.type}</s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={t.status} />
                  </s-table-cell>
                  <s-table-cell>
                    {t.usedAt != null
                      ? new Date(t.usedAt).toLocaleString()
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {new Date(t.createdAt).toLocaleString()}
                  </s-table-cell>
                  <s-table-cell>{t.email ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <s-button
                        icon="edit"
                        variant="tertiary"
                        size="slim"
                        onClick={() => onEdit(t)}
                        aria-label="Edit ticket"
                      />
                      <s-button
                        icon="delete"
                        variant="tertiary"
                        tone="critical"
                        size="slim"
                        onClick={() => onRemove(t)}
                        aria-label="Remove ticket"
                      />
                    </div>
                  </s-table-cell>
                </s-table-row>
              ))
            )}
          </s-table-body>
        </s-table>
      </s-section>

      {/* Pagination */}
      {totalPages > 0 && (
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--p-color-border, #e1e3e5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
          }}
        >
          <s-button
            variant="tertiary"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            ‹
          </s-button>
          <span style={{ padding: "0 8px", fontSize: "14px" }}>
            {page} of {totalPages}
          </span>
          <s-button
            variant="tertiary"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            ›
          </s-button>
        </div>
      )}
    </s-box>
  );
}
