import { DefaultExecutor } from "./default.js";
import { ORCAROUTER_FREE_ERROR_CODE } from "../config/orcarouter.js";

export class OrcaRouterExecutor extends DefaultExecutor {
  constructor() {
    super("orcarouter");
  }

  parseError(response, bodyText) {
    const parsed = super.parseError(response, bodyText);
    try {
      const { error } = JSON.parse(bodyText);
      // A free-access gate or prompt cap needs user action. It is not a quota
      // window, despite sharing the upstream free_rate_limited error code.
      if (error?.code === ORCAROUTER_FREE_ERROR_CODE && error.metadata?.retryable === false) {
        return {
          ...parsed,
          retryable: false,
          errorDetails: { code: error.code, type: error.type, metadata: error.metadata, retryable: false },
        };
      }
    } catch { /* Keep the shared readable error for non-JSON upstream failures. */ }
    return parsed;
  }
}
