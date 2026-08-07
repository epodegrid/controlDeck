import type { StandardError } from "../types.js";

export function statusForError(err: StandardError): number {
  switch (err.error.code) {
    case "auth_invalid":
      return 401;
    case "capability_mismatch":
      return 422;
    case "invalid_request":
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

export function replicaUnavailable(message: string): StandardError {
  return { error: { type: "capacity_error", code: "replica_unavailable", message } };
}

export function queueTimeoutError(message: string): StandardError {
  return { error: { type: "timeout_error", code: "queue_timeout", message } };
}
