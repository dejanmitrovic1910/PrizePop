import { forwardRef, useEffect } from "react";

const ADD_MODAL_ID = "add-ticket-modal";

export interface AddTicketModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  isLoading?: boolean;
}

export const AddTicketModal = forwardRef<
  HTMLElement & { showOverlay?: () => void; hideOverlay?: () => void },
  AddTicketModalProps
>(function AddTicketModal(
  { open, onClose, onSubmit, isLoading = false },
  ref
) {
  useEffect(() => {
    if (open) {
      (ref as React.RefObject<HTMLElement & { showOverlay?: () => void }>)?.current?.showOverlay?.();
    }
  }, [open, ref]);

  const handleHide = () => {
    onClose();
  };

  return (
    <s-modal
      ref={ref as never}
      id={ADD_MODAL_ID}
      heading="Add ticket"
      accessibilityLabel="Add new ticket"
      size="base"
      padding="base"
      onAfterHide={handleHide}
    >
      <form id="add-ticket-form" onSubmit={onSubmit}>
        <s-stack gap="base">
          <s-text-field
            label="Code"
            name="code"
            placeholder="Ticket code"
            maxLength={500}
            required
          />
          <s-select label="Type" name="type" value="Golden">
            <s-option value="Golden">Golden</s-option>
            <s-option value="Platinum">Platinum</s-option>
          </s-select>
        </s-stack>
      </form>
      <s-button
        slot="secondary-actions"
        variant="secondary"
        commandFor={ADD_MODAL_ID}
        command="--hide"
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => document.getElementById("add-ticket-form")?.requestSubmit?.()}
        disabled={isLoading}
        {...(isLoading ? { loading: true } : {})}
      >
        {isLoading ? "Adding…" : "Add ticket"}
      </s-button>
    </s-modal>
  );
});
