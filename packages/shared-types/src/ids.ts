/**
 * Identifier formats shared by the server, the browser and the files on disk.
 */
import { z } from "zod";

/**
 * Ids of saved connection profiles and workspaces: URL-safe tokens of 8 to 64
 * characters (letters, digits, "_" and "-").
 *
 * SECURITY: a workspace id becomes part of a FILE NAME (`<id>.json`). This
 * pattern contains no "/", "\", "." or other path characters, so an id can never
 * point outside the data folder (a path traversal such as "../../etc/passwd" is
 * rejected before any file is touched).
 */
export const profileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const workspaceIdSchema = profileIdSchema;
