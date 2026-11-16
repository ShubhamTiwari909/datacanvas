/**
 * Saved connection PROFILES: the non-secret part of a connection (where the
 * database is and who connects), kept so the user need not retype it.
 *
 * SECURITY: a profile NEVER contains a password; that is the whole point of the
 * type. Reconnecting a profile asks for the password again.
 */
import { z } from "zod";
import { profileIdSchema } from "./ids.js";
import { postgresConnectionSummarySchema } from "./postgres-connection.js";
import { migrateToCurrent, type Migration } from "./versioned-file.js";

export const CONNECTIONS_FILE_FORMAT = "datacanvas-connections";
export const CURRENT_CONNECTIONS_FILE_VERSION = 2;
export const MAX_PROFILES = 100;

export const connectionProfileSchema = postgresConnectionSummarySchema
  .omit({ hasPassword: true })
  .extend({
    id: profileIdSchema,
    provider: z.literal("postgresql"),
    createdAt: z.iso.datetime(),
  });
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;

/** The file `~/.datacanvas/connections.json`. */
export const connectionsFileSchema = z.object({
  format: z.literal(CONNECTIONS_FILE_FORMAT),
  schemaVersion: z.literal(CURRENT_CONNECTIONS_FILE_VERSION),
  profiles: z.array(connectionProfileSchema).max(MAX_PROFILES),
});
export type ConnectionsFile = z.infer<typeof connectionsFileSchema>;

/**
 * 1 -> 2: version 2 added `dataAccess` (viewing table rows) to every profile. A
 * profile saved before it never allowed it, so every existing profile gets
 * `false`: nothing that was read-only becomes readable by an upgrade.
 */
export const CONNECTIONS_MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: (data) => {
    if (!Array.isArray(data.profiles)) return data;
    return {
      ...data,
      profiles: data.profiles.map((profile: unknown) =>
        typeof profile === "object" && profile !== null && !Array.isArray(profile)
          ? { ...profile, dataAccess: false }
          : profile,
      ),
    };
  },
};

export type ParsedConnectionsFile =
  { ok: true; file: ConnectionsFile } | { ok: false; message: string };

export function parseConnectionsFile(raw: unknown): ParsedConnectionsFile {
  const migrated = migrateToCurrent(raw, {
    format: CONNECTIONS_FILE_FORMAT,
    current: CURRENT_CONNECTIONS_FILE_VERSION,
    migrations: CONNECTIONS_MIGRATIONS,
  });
  if (!migrated.ok) return { ok: false, message: migrated.message };
  const parsed = connectionsFileSchema.safeParse(migrated.data);
  return parsed.success
    ? { ok: true, file: parsed.data }
    : { ok: false, message: "The saved connections file is damaged or incomplete." };
}

export const listProfilesResponseSchema = z.object({ profiles: z.array(connectionProfileSchema) });
export type ListProfilesResponse = z.infer<typeof listProfilesResponseSchema>;

export function emptyConnectionsFile(): ConnectionsFile {
  return {
    format: CONNECTIONS_FILE_FORMAT,
    schemaVersion: CURRENT_CONNECTIONS_FILE_VERSION,
    profiles: [],
  };
}
