/**
 * Upgrading saved files to the current format.
 *
 * Every file DataCanvas writes carries `format` (what kind of file it is) and
 * `schemaVersion` (which layout of that kind). When a later release changes the
 * layout it bumps the version and adds ONE migration: a pure function from
 * version N to N+1. A file written by any older release is then upgraded by
 * running the migrations in order, and only then validated against the current
 * schema, so the rest of the code only ever sees the current layout.
 *
 *   v1 file --migrations[1]--> v2 --migrations[2]--> v3 (current) --> validate
 *
 * A file from a NEWER release is refused (we cannot know what changed) rather
 * than guessed at, so a downgrade never silently corrupts someone's work.
 *
 * Messages are fixed sentences and never echo the file's content.
 */

/** Upgrades the data of version N to the layout of version N+1. */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

export interface VersionedFileSpec {
  /** Value of the `format` field, e.g. "datacanvas-workspace". */
  format: string;
  /** The version this release writes. */
  current: number;
  /** `migrations[n]` upgrades version n to n + 1. There must be one for every version below `current`. */
  migrations: Readonly<Record<number, Migration>>;
}

export type MigrationResult =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      reason: "not_a_file" | "wrong_format" | "bad_version" | "newer_version";
      message: string;
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function migrateToCurrent(raw: unknown, spec: VersionedFileSpec): MigrationResult {
  if (!isObject(raw)) {
    return { ok: false, reason: "not_a_file", message: "This is not a DataCanvas file." };
  }
  if (raw.format !== spec.format) {
    return {
      ok: false,
      reason: "wrong_format",
      message: "This is not the kind of DataCanvas file that was expected.",
    };
  }
  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: "bad_version", message: "The file has no valid format version." };
  }
  if (version > spec.current) {
    return {
      ok: false,
      reason: "newer_version",
      message: `This file was created by a newer version of DataCanvas (file format ${version}; this version understands up to ${spec.current}). Update DataCanvas to open it.`,
    };
  }

  let data: Record<string, unknown> = raw;
  for (let step = version; step < spec.current; step += 1) {
    const migrate = spec.migrations[step];
    if (!migrate) {
      // A gap in the chain is a bug in DataCanvas, not in the file.
      return {
        ok: false,
        reason: "bad_version",
        message: `This file format (${version}) can no longer be upgraded.`,
      };
    }
    data = { ...migrate(data), schemaVersion: step + 1 };
  }
  return { ok: true, data };
}
