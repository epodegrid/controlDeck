import type { StandardError } from "../types.js";

export function statusForError(err: StandardError): number {
  switch (err.error.code) {
    case "auth_invalid":
      return 401;
    case "model_not_found":
      // What OpenAI returns for an unknown model, and what clients branch on
      // to tell a typo in the model name from a request they must change.
      return 404;
    case "capability_mismatch":
      return 422;
    case "invalid_request":
    case "context_length_exceeded":
      return 400;
    case "queue_timeout":
    case "stall_timeout":
      return 504;
    case "replica_unavailable":
      return 503;
    default:
      return 500;
  }
}

export function invalidRequest(message: string): StandardError {
  return { error: { type: "invalid_request_error", code: "invalid_request", message } };
}

/**
 * A prompt that exceeds the model's context window.
 *
 * Kept distinct from invalid_request because it is the one client error with a
 * remedy the caller can apply automatically: drop or summarise older turns and
 * send again. Agents look for this exact code to do that.
 */
export function contextLengthExceeded(message: string): StandardError {
  return {
    error: { type: "invalid_request_error", code: "context_length_exceeded", message },
  };
}

export function replicaUnavailable(message: string): StandardError {
  return { error: { type: "capacity_error", code: "replica_unavailable", message } };
}

export function queueTimeoutError(message: string): StandardError {
  return { error: { type: "timeout_error", code: "queue_timeout", message } };
}
