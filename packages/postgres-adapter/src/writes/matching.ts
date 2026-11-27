/**
 * A change of every row a filter matches (`docs/write-side-v2-plan.md`, section 6; decisions 2 and 3 of section 11):
 * `update_matching` sets one value on those rows, `delete_matching` deletes them.
 *
 * The rule of this file: A WRITE STATEMENT IS NEVER BUILT FROM THE FILTER. The filter is handed once, whole, to the
 * read of the preview (`readMatchingKeys`: the page reader's own statement, in the preview's read-only transaction),
 * which returns the keys of the matching rows and nothing else. Every statement of the plan is a keyed batch built
 * from those keys by the builders of the import by key (`buildUpdateByKeyBatch`, `buildDeleteByKeyBatch`): up to 500
 * keys a batch, catalog names, every key and the value bound, each batch checked to touch exactly the rows it
 * carries, all in one transaction:
 *
 *   UPDATE "s"."t" AS dc_t SET "c" = CAST($2 AS <type>)
 *   FROM unnest($1::text[]) AS x(c0) WHERE dc_t."k" = CAST(x.c0 AS <type>)
 *
 *   DELETE FROM "s"."t" AS dc_t USING unnest($1::text[]) AS x(c0) WHERE dc_t."k" = CAST(x.c0 AS <type>)
 *
 * The keys stay in the plan (server memory, as the batches bind them: one array of text per key column per batch,
 * 13.4) and only their count goes back, which the person types to apply. The values the rows hold are not compared:
 * the rows were chosen by the filter (decision 3), and a row deleted, or whose key changed, since the preview makes a
 * batch short, which rolls everything back.
 */
import {
  isSensitiveColumnName,
  type ChangeWarning,
  type DeleteMatchingChange,
  type PlannedChange,
  type UpdateMatchingChange,
} from "@datacanvas/database-core";
import {
  MATCHING_LIMITS,
  readMatchingKeys,
  type MatchingLimits,
} from "../introspection/matching-keys.js";
import type { Queryable } from "../introspection/types.js";
import {
  TRIGGER_EVENT,
  cascadesOntoItself,
  listCascadeChain,
  listIncomingForeignKeys,
  type CatalogTable,
} from "./catalog.js";
import { guardRelation } from "./guard.js";
import { buildDeleteByKeyBatch, buildUpdateByKeyBatch, type KeyedColumn } from "./keyed.js";
import {
  bulkWarnings,
  checkValues,
  findColumn,
  referencedWarning,
  requireEditable,
  requireNoChildren,
  requireWritable,
} from "./rows.js";
import { displayName, invalidChange, listWords } from "./sql.js";

/** The refusal of an empty filter: never "the whole table" (that is `TRUNCATE`'s job, and DataCanvas does not do it). */
export const EMPTY_FILTER =
  "A change of the rows a filter matches needs at least one condition: the whole table is never changed this way.";
/** A batch that is short at apply: a row the preview found is gone, or its key changed. Nothing was written. */
/** A filtered delete on a table whose cascade reaches its own rows, in more than one batch. */
export const SELF_REFERENCE_BATCHES =
  "This table's rows cascade onto other rows of the same table, so more than 500 of them cannot be deleted by filter in one change. Narrow the filter or delete them in smaller groups.";
export const MATCHING_ROW_GONE =
  "A row that matched the filter was deleted, or its key changed, since the preview, so nothing was changed. Preview again.";

const many = (n: number, one: string, more = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : more}`;

/** The key's columns, as the catalog names and types them, in the key's order. */
const typedKey = (table: CatalogTable, key: readonly string[]): KeyedColumn[] =>
  key.map((name) => ({ column: name, castType: findColumn(table, name).castType }));

/**
 * The keys of the matching rows: the ONE use of the filter, a read. A refusal names a limit, never a key or a value.
 */
async function holdKeys(
  db: Queryable,
  change: UpdateMatchingChange | DeleteMatchingChange,
  key: readonly string[],
  limits: MatchingLimits,
): Promise<{ count: number; batches: string[][][] }> {
  const found = await readMatchingKeys(
    db,
    change.table,
    key,
    { filters: change.filters, revealColumns: change.revealColumns },
    limits,
  );
  switch (found.kind) {
    case "too_many_rows":
      throw invalidChange(
        `More than ${many(limits.rows, "row")} match this filter: narrow the filter. A change of the rows a filter matches changes at most ${many(limits.rows, "row")}.`,
      );
    case "too_much_key_text":
      throw invalidChange(
        `The keys of the rows this filter matches hold more than ${many(limits.keyChars, "character")} in all, which is more than a change can hold: narrow the filter.`,
      );
    case "key_value_too_long":
      throw invalidChange(
        `A row this filter matches has a key value longer than ${many(limits.keyValueChars, "character")}, which a change of the rows a filter matches cannot hold: narrow the filter.`,
      );
    case "keys":
      break;
  }
  if (found.count === 0) {
    throw invalidChange("No row matches this filter now, so nothing would change.");
  }
  return found;
}

/** The sentences every change of the rows a filter matches says (6.5 and 6.7 of the plan). */
const byKeyWords = (key: readonly string[], verb: "changed" | "deleted"): string =>
  `Rows are found by their key (${listWords(key)}) when you apply: a row that matches the filter only after this preview is not ${verb}.`;

export async function planUpdateMatching(
  db: Queryable,
  change: UpdateMatchingChange,
  limits: MatchingLimits = MATCHING_LIMITS,
): Promise<PlannedChange> {
  if (change.filters.length === 0) throw invalidChange(EMPTY_FILTER);
  const { table, key } = await requireEditable(db, change.table);
  await requireNoChildren(db, table);
  const column = findColumn(table, change.set.column);
  requireWritable(column);
  if (key.includes(column.name)) {
    throw invalidChange(
      `${column.name} is part of the key that finds the rows (${listWords(key)}), so it cannot be set on the rows a filter matches.`,
    );
  }
  // As for a page of rows: a column whose name looks sensitive is set only when the person revealed it.
  if (isSensitiveColumnName(column.name) && !change.revealColumns.includes(column.name)) {
    throw invalidChange(`${column.name} is hidden: reveal it before setting a value on it.`);
  }
  const same = { column: column.name, castType: column.castType, value: change.set.value };
  await checkValues(db, [same], (name) => findColumn(table, name).dataType);

  const keyColumns = typedKey(table, key);
  const held = await holdKeys(db, change, key, limits);
  const statements = held.batches.map((rows) =>
    buildUpdateByKeyBatch(change.table, keyColumns, key, rows, [same]),
  );
  const count = held.count;
  const warnings = await bulkWarnings(
    db,
    change.table,
    table,
    TRIGGER_EVENT.update,
    count,
    statements.length,
  );
  const referenced = referencedWarning(await listIncomingForeignKeys(db, table.oid), "update", [
    column.name,
  ]);
  if (referenced) warnings.push(referenced);
  warnings.push({
    code: "destructive",
    message: `${many(count, "row")} will be overwritten: the values ${count === 1 ? "it holds" : "they hold"} now in ${column.name} cannot be brought back. The rows were chosen by the filter, and are changed even if they changed since: their values are not compared.`,
  });
  const name = displayName(change.table.schema, change.table.name);
  return {
    change,
    statements,
    expect: "any",
    category: "row",
    effect: `Sets ${column.name} on the ${many(count, "row")} of ${name} that ${count === 1 ? "matches" : "match"} the filter now. ${byKeyWords(key, "changed")} ${many(statements.length, "batch", "batches")}, all in one transaction: every row is changed or none is.`,
    warnings,
    destructive: true,
    guard: { relations: [guardRelation(table, [...key, column.name], "row_exclusive")] },
    confirmRows: count,
  };
}

export async function planDeleteMatching(
  db: Queryable,
  change: DeleteMatchingChange,
  limits: MatchingLimits = MATCHING_LIMITS,
): Promise<PlannedChange> {
  if (change.filters.length === 0) throw invalidChange(EMPTY_FILTER);
  const { table, key } = await requireEditable(db, change.table);
  await requireNoChildren(db, table);
  const keyColumns = typedKey(table, key);
  const held = await holdKeys(db, change, key, limits);
  // A delete that cascades onto rows of its own table: one batch deletes every row it carries in ONE statement (the
  // cascade finds nothing left), but a cascade of an earlier batch would remove rows of a later one, and the later
  // batch would come up short at apply. More than one batch is refused here, in words, instead of there.
  const selfCascade = await cascadesOntoItself(db, table.oid);
  if (selfCascade && held.batches.length > 1) throw invalidChange(SELF_REFERENCE_BATCHES);
  const statements = held.batches.map((rows) =>
    buildDeleteByKeyBatch(change.table, keyColumns, rows),
  );
  const count = held.count;
  const warnings: ChangeWarning[] = await bulkWarnings(
    db,
    change.table,
    table,
    TRIGGER_EVENT.delete,
    count,
    statements.length,
  );
  const referenced = referencedWarning(
    await listIncomingForeignKeys(db, table.oid),
    "delete",
    null,
  );
  const chain = await listCascadeChain(db, table.oid);
  const further = `The cascade goes further down: rows of ${listWords(chain)} can be deleted too.`;
  if (referenced && chain.length > 0) referenced.message += ` ${further}`;
  else if (chain.length > 0) warnings.push({ code: "referenced", message: further });
  if (referenced) warnings.push(referenced);
  if (selfCascade) {
    warnings.push({
      code: "referenced",
      message:
        "The rows of this table cascade onto other rows of this same table: deleting a row also deletes the rows that point at it, so more rows than the ones counted here can go.",
    });
  }
  warnings.push({
    code: "destructive",
    message:
      "Deleted rows cannot be brought back. The rows were chosen by the filter, and are deleted even if they changed since: their values are not compared.",
  });
  const name = displayName(change.table.schema, change.table.name);
  return {
    change,
    statements,
    expect: "any",
    category: "row",
    effect: `Deletes the ${many(count, "row")} of ${name} that ${count === 1 ? "matches" : "match"} the filter now. ${byKeyWords(key, "deleted")} ${many(statements.length, "batch", "batches")}, all in one transaction: every row is deleted or none is.`,
    warnings,
    destructive: true,
    guard: { relations: [guardRelation(table, key, "row_exclusive")] },
    confirmRows: count,
  };
}
