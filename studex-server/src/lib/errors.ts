/**
 * Errors that are safe to show a client. Anything thrown that is not an
 * ApiError is reported as a generic 500 so internal details never leak.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg = 'Invalid request', details?: unknown) =>
  new ApiError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') =>
  new ApiError(401, 'unauthorized', msg);
/**
 * This device's session ended because the account signed in elsewhere. The
 * client uses the code to explain itself rather than blaming an expiry.
 */
export const sessionReplaced = (
  msg = 'Signed out because this account signed in on another device.',
) => new ApiError(401, 'session_replaced', msg);
export const forbidden = (msg = 'Not permitted') => new ApiError(403, 'forbidden', msg);
/** The account is not entitled to this. Paying is what changes the answer. */
export const paymentRequired = (msg = 'Payment required') =>
  new ApiError(402, 'payment_required', msg);
/** Allowed on a paid tier, refused on this one. */
export const planLimit = (msg = 'Your plan does not allow that', details?: unknown) =>
  new ApiError(402, 'plan_limit', msg, details);
export const notFound = (msg = 'Not found') => new ApiError(404, 'not_found', msg);
export const conflict = (msg = 'Conflict') => new ApiError(409, 'conflict', msg);
export const payloadTooLarge = (msg = 'Payload too large') =>
  new ApiError(413, 'payload_too_large', msg);
export const unprocessable = (msg = 'Unprocessable', details?: unknown) =>
  new ApiError(422, 'unprocessable', msg, details);
export const tooManyRequests = (msg = 'Too many requests') =>
  new ApiError(429, 'too_many_requests', msg);
export const quotaExceeded = (msg = 'Storage quota exceeded') =>
  new ApiError(507, 'quota_exceeded', msg);
