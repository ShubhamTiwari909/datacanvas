/**
 * Helpers for building SQL TEXT that is shown to the user to copy (suggested
 * indexes, generated joins). DataCanvas never runs this text from here.
 *
 * The implementation lives in `@datacanvas/database-core` (`quoteIdentifier`),
 * because the PostgreSQL adapter needs the very same quoting for the queries it
 * does run; this file keeps the names the web app already uses.
 */
export { quoteIdentifier as quoteIdent, quoteQualified } from "@datacanvas/database-core";
