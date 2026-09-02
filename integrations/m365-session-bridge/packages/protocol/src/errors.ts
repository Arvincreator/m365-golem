/**
 * Unified bridge error codes (spec section 28).
 * Every failure surfaced to M365 Golem MUST use one of these codes rather than a
 * bare "something went wrong" message.
 */
export const ErrorCode = {
  BRIDGE_OFFLINE: "BRIDGE_OFFLINE",
  EDGE_EXTENSION_OFFLINE: "EDGE_EXTENSION_OFFLINE",
  M365_SESSION_REQUIRED: "M365_SESSION_REQUIRED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  HOST_NOT_ALLOWED: "HOST_NOT_ALLOWED",
  SITE_NOT_ALLOWED: "SITE_NOT_ALLOWED",
  LOCAL_PATH_NOT_ALLOWED: "LOCAL_PATH_NOT_ALLOWED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  FORBIDDEN_BY_POLICY: "FORBIDDEN_BY_POLICY",
  NEEDS_USER_CONFIRMATION: "NEEDS_USER_CONFIRMATION",
  NOT_SUPPORTED_SESSION_BRIDGE: "NOT_SUPPORTED_SESSION_BRIDGE",
  UNSUPPORTED_DOCUMENT_EDIT: "UNSUPPORTED_DOCUMENT_EDIT",
  UPLOAD_FAILED: "UPLOAD_FAILED",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  REQUEST_DIGEST_FAILED: "REQUEST_DIGEST_FAILED",
  M365_PERMISSION_DENIED: "M365_PERMISSION_DENIED",
  INVALID_INPUT: "INVALID_INPUT",
  /**
   * SharePoint throttled the request (HTTP 429/503) and it still failed after
   * honoring Retry-After for the maximum number of retries. Surfaced as its own
   * code so the user sees "you are being rate limited, wait and retry" rather
   * than a generic internal error. Microsoft warns that throttled requests
   * themselves count toward the limit, so the bridge must not retry harder.
   */
  THROTTLED: "THROTTLED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }

  toToolResult() {
    return {
      status: "error" as const,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
