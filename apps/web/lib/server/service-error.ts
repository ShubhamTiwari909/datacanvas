/**
 * Errors raised by DataCanvas' own server logic (as opposed to the database).
 * Database failures are `DatabaseError`s from @datacanvas/database-core.
 */
export type ServiceErrorCode = "connection_not_found" | "connection_limit_reached";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}
