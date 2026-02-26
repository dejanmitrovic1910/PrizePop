import { forwardRef, useEffect } from "react";
import type { TicketRow } from "./TicketsTable";

const EDIT_MODAL_ID = "edit-ticket-modal";

export interface EditTicketModalProps {
  ticket: TicketRow | null;
  onClose: () => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  isLoading?: boolean;
}

export const EditTicketModal = forwardRef<
  HTMLElement & { showOverlay?: () => void; hideOverlay?: () => void },
  EditTicketModalProps
>(function EditTicketModal(
  { ticket, onClose, onSubmit, isLoading = false },
  ref
) {
  useEffect(() => {
    if (ticket) {
      (ref as React.RefObject<HTMLElement & { showOverlay?: () => void }>)?.current?.showOverlay?.();
    }
  }, [ticket, ref]);

  const handleHide = () => {
    onClose();
  };

  const handleSaveClick = () => {
    const form = document.getElementById("edit-ticket-form");
    if (form instanceof HTMLFormElement) form.requestSubmit();
  };

  return (
    <s-modal
      ref={ref as never}
      id={EDIT_MODAL_ID}
      heading="Edit ticket"
      accessibilityLabel="Edit ticket"
      size="base"
      padding="base"
      onAfterHide={handleHide}
    >
      {ticket && (
        <>
          <form id="edit-ticket-form" onSubmit={onSubmit}>
            <s-stack gap="base">
              <s-text-field
                label="Code"
                name="code"
                value={ticket.code}
                maxLength={500}
              />
              <s-select label="Type" name="type" value={ticket.type}>
                <s-option value="Golden">Golden</s-option>
                <s-option value="Platinum">Platinum</s-option>
              </s-select>
              <s-select label="Status" name="status" value={ticket.status}>
                <s-option value="ACTIVE">ACTIVE</s-option>
                <s-option value="RESERVED">RESERVED</s-option>
                <s-option value="DISABLED">DISABLED</s-option>
                <s-option value="ACTIVATE">ACTIVATE</s-option>
              </s-select>
            </s-stack>
            <input type="hidden" name="id" value={ticket.id} />
          </form>
          <s-button
            slot="secondary-actions"
            variant="secondary"
            commandFor={EDIT_MODAL_ID}
            command="--hide"
          >
            Cancel
          </s-button>
          <s-button
            slot="primary-action"
            variant="primary"
            onClick={handleSaveClick}
            disabled={isLoading}
            {...(isLoading ? { loading: true } : {})}
          >
            {isLoading ? "Saving…" : "Save"}
          </s-button>
        </>
      )}
    </s-modal>
  );
});
