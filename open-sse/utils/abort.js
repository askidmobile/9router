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

/**
 * Upstream deadline marker. A timeout says the REQUEST was too slow, not that the provider is
 * down, so it has to reach callers as a distinguishable class: every layer maps a bare Error to
 * 502, and a combo freezes the member on 502 while it deliberately keeps 504 in rotation.
 * UND_ERR_CONNECT_TIMEOUT is NOT in the list on purpose — an unreachable TCP endpoint is
 * evidence about the provider, not about the request.
 */
export function createUpstreamTimeoutError(message = "Upstream timeout", options) {
  const error = new Error(message, options);
  error.code = "UPSTREAM_TIMEOUT";
  return error;
}

const UPSTREAM_TIMEOUT_CODES = ["UPSTREAM_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"];

export function isUpstreamTimeoutError(error) {
  if (!error) return false;
  return UPSTREAM_TIMEOUT_CODES.includes(error.code) || UPSTREAM_TIMEOUT_CODES.includes(error.cause?.code);
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
