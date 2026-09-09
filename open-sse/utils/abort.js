export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
}

/** Internal deadline marker, stable across separate Next module instances. */
export function createComboDeadlineError(message = "Combo deadline exceeded") {
  const error = new Error(message);
  error.name = "ComboDeadlineError";
  error.code = "COMBO_DEADLINE_EXCEEDED";
  return error;
}

export function isComboDeadlineError(error) {
  return error?.name === "ComboDeadlineError" && error?.code === "COMBO_DEADLINE_EXCEEDED";
}

/** Wait without leaving a retry timer or listener behind after cancellation. */
export function abortableDelay(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
