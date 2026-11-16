/**
 * Errors raised by DataCanvas' own server logic (as opposed to the database).
 * Database failures are `DatabaseError`s from @datacanvas/database-core.
 */
export type ServiceErrorCode =
  | "connection_not_found"
  | "connection_limit_reached"
  | "profile_not_found"
  | "workspace_not_found"
  | "workspace_limit_reached"
  | "invalid_workspace_file"
  | "data_access_disabled"
  | "rows_busy"
  | "snapshot_not_found"
  | "snapshot_limit_reached"
  | "snapshot_too_large"
  | "invalid_snapshot_file"
  | "storage_error";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

/** The one message for any failure to read or write the data folder. It never includes the path or the system's message. */
export const STORAGE_ERROR_MESSAGE =
  "DataCanvas could not read or write its data folder. Check that it exists and that you are allowed to write to it.";

/**
 * Run a file-system operation, turning any failure that is not already one of
 * ours into a `storage_error`. The original error stays as `cause` for logs.
 */
export async function guardStorage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw Object.assign(new ServiceError("storage_error", STORAGE_ERROR_MESSAGE), { cause: error });
  }
}
