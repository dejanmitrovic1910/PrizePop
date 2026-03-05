import prisma from "./db.server";

const RESERVATION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const releaseTimers = new Map<string, NodeJS.Timeout>();

/**
 * Schedule a release of the prize reservation after 15 minutes.
 * Call this when claim (add to cart) succeeds. If there was already a timer for this ticket, it is cleared first.
 */
export function scheduleReleaseAfter15Min(ticketId: string, prizeId: string) {
  clearReleaseTimer(ticketId);
  const timerId = setTimeout(async () => {
    releaseTimers.delete(ticketId);
    try {
      const ticket = await prisma.ticketCode.findUnique({ where: { id: ticketId } });
      if (!ticket) return;
      if (ticket.status === "DISABLED") return;
      if (ticket.usedAt ?? ticket.usedOrderId) return;
      if (ticket.reservedPrizeId !== prizeId) return;
      await prisma.ticketCode.update({
        where: { id: ticketId },
        data: { reservedPrizeId: null, reservationExpiresAt: null },
      });
    } catch {
      // ignore
    }
  }, RESERVATION_WINDOW_MS);
  releaseTimers.set(ticketId, timerId);
}

/**
 * Clear the 15-minute release timer for this ticket (e.g. when user removes prize from cart or adds a different one).
 */
export function clearReleaseTimer(ticketId: string) {
  const timerId = releaseTimers.get(ticketId);
  if (timerId) {
    clearTimeout(timerId);
    releaseTimers.delete(ticketId);
  }
}
