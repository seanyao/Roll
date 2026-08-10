/**
 * @responsibility Binds a delivery writer to the immutable terminal reservation it closes.
 */
/**
 * Bind a delivery writer to the immutable terminal reservation it is actually
 * closing.  Cycle delivery events normally carry no Delta identity; they gain
 * one only when their durable run is the terminal host-Delta run itself.
 */
export function hostDeltaDeliveryBinding(
  events: readonly Record<string, unknown>[],
  storyId: string,
  runId: string,
): { delegationId: string; runId: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "delta:terminal"
      || event.storyId !== storyId
      || event.runId !== runId
      || event.reservationSource !== "delivery-reservation"
      || typeof event.delegationId !== "string") continue;
    return { delegationId: event.delegationId, runId };
  }
  return undefined;
}
