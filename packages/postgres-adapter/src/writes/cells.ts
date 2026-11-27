/**
 * Edit cells of several rows (`edit_cells`, `docs/write-side-v2-plan.md`, section 5; decision 7 of section 11): each
 * row sets its OWN columns to its OWN values. There is no new statement shape: each row is ONE update built by the
 * builder of a single row (`buildUpdateRow`), with its own columns and its own values that were seen:
 *
 *   UPDATE "s"."t" SET "a" = CAST($1 AS <type of a>), "b" = CAST($2 AS <type of b>)
 *   WHERE "k" = CAST($3 AS <type of k>)
 *     AND CAST("a" AS text) IS NOT DISTINCT FROM CAST($4 AS text)
 *     AND CAST("b" AS text) IS NOT DISTINCT FROM CAST($5 AS text)
 *   RETURNING 1
 *
 * and every statement must change exactly one row (`expect: "one_row"`), all in one transaction under a plan guard.
 * The preview asks, in its read-only transaction, which rows still hold what the person saw (the one fixed read of a
 * bulk change, `buildRowStillHolds`); a row that does not is left out and counted (`skipped`, positions only), and
 * when none is left the change is `row_changed`. A row that changes between the preview and the apply makes its
 * statement change no row, which rolls everything back.
 *
 * The columns follow the rules of the row form, checked here and not only by the grid: a column the database fills
 * (generated, `GENERATED ALWAYS` identity) or `bytea` is refused by `requireWritable`, a table without a key by
 * `requireEditable`; a key column is refused (a key is changed one row at a time, in the form: decision 7), and so is
 * a column whose name looks sensitive unless the person revealed it, as a page of rows reads it. A key column whose
 * name looks sensitive must be revealed too (as `getCell` asks), or a key could be guessed by what is left out.
 *
 * Like `update_rows`, the change is NOT destructive (no tick): each value it overwrites is compared with the value the
 * person saw, and a row that holds anything else is left out. No value is put in a statement's text, an error, the
 * preview, the history or `skipped`.
 */
import {
  DatabaseError,
  EDIT_CELLS_MAX_CELLS,
  EDIT_CELLS_MAX_CELLS_PER_ROW,
  MAX_BULK_ROWS,
  MAX_CHANGE_VALUE_CHARS,
  isSensitiveColumnName,
  type EditCellsChange,
  type PlannedChange,
} from "@datacanvas/database-core";
import type { Queryable } from "../introspection/types.js";
import { TRIGGER_EVENT, listIncomingForeignKeys, type CatalogColumn } from "./catalog.js";
import { guardRelation } from "./guard.js";
import {
  buildUpdateRow,
  bulkWarnings,
  checkValues,
  distinctRows,
  findColumn,
  leftOutWords,
  referencedWarning,
  requireEditable,
  requireNoChildren,
  requireWritable,
  splitByCurrent,
  typedKey,
  type TypedValue,
} from "./rows.js";
import { displayName, invalidChange, listWords } from "./sql.js";

const many = (n: number, one: string, more = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : more}`;

export async function planEditCells(
  db: Queryable,
  change: EditCellsChange,
): Promise<PlannedChange> {
  const { table, key } = await requireEditable(db, change.table);
  await requireNoChildren(db, table);
  if (change.rows.length === 0) throw invalidChange("Nothing to change.");
  if (change.rows.length > MAX_BULK_ROWS) throw invalidChange("Too many rows for one change.");
  const hidden = (name: string): boolean =>
    isSensitiveColumnName(name) && !change.revealColumns.includes(name);
  // The rows are found by their key: a hidden key column would let a guess be tested by what is left out.
  const hiddenKey = key.filter(hidden);
  if (hiddenKey.length > 0) {
    throw invalidChange(
      `${listWords(hiddenKey)} ${hiddenKey.length === 1 ? "is a column" : "are columns"} of the key and hidden: reveal ${hiddenKey.length === 1 ? "it" : "them"} to edit these rows.`,
    );
  }

  // Every column is checked once, before anything is read: a refused column is never compared with what was seen.
  const checked = new Map<string, CatalogColumn>();
  const writable = (name: string): CatalogColumn => {
    const known = checked.get(name);
    if (known) return known;
    const column = findColumn(table, name);
    requireWritable(column);
    if (key.includes(column.name)) {
      throw invalidChange(
        `${column.name} is part of the key that finds the rows (${listWords(key)}), so it cannot be edited here. A key is changed one row at a time.`,
      );
    }
    if (hidden(column.name)) {
      throw invalidChange(`${column.name} is hidden: reveal it before editing it.`);
    }
    checked.set(name, column);
    return column;
  };
  const sets = change.rows.map((row): TypedValue[] => {
    if (row.changes.length === 0) throw invalidChange("A row has no cell to change.");
    if (row.changes.length > EDIT_CELLS_MAX_CELLS_PER_ROW) {
      throw invalidChange(
        `A row can have at most ${EDIT_CELLS_MAX_CELLS_PER_ROW} cells changed in one change.`,
      );
    }
    if (new Set(row.changes.map((c) => c.column)).size !== row.changes.length) {
      throw invalidChange("A column is changed twice in one row.");
    }
    return row.changes.map((cell): TypedValue => {
      const column = writable(cell.column);
      for (const text of [cell.value, cell.expected]) {
        if (text !== null && text.length > MAX_CHANGE_VALUE_CHARS) {
          throw invalidChange(
            `A value in ${column.name} is longer than the ${MAX_CHANGE_VALUE_CHARS.toLocaleString("en-US")} characters a change can carry.`,
          );
        }
      }
      return { column: column.name, castType: column.castType, value: cell.value };
    });
  });
  if (sets.reduce((sum, set) => sum + set.length, 0) > EDIT_CELLS_MAX_CELLS) {
    throw invalidChange(
      `At most ${EDIT_CELLS_MAX_CELLS.toLocaleString("en-US")} cells can be changed in one change.`,
    );
  }
  const keys = change.rows.map((r) => typedKey(table, key, r.key));
  distinctRows(keys);

  // Each value is checked by its type once, however many rows it is set on (NULL needs no check).
  const distinct = new Map<string, TypedValue>();
  for (const set of sets) {
    for (const s of set) {
      if (s.value !== null) distinct.set(JSON.stringify([s.column, s.value]), s);
    }
  }
  await checkValues(db, [...distinct.values()], (name) => findColumn(table, name).dataType);

  const seen = change.rows.map((r) =>
    r.changes.map((c) => ({ column: c.column, value: c.expected })),
  );
  const { kept, skipped } = await splitByCurrent(
    db,
    change.table,
    keys.map((k, i) => ({ key: k, expected: seen[i]! })),
  );
  if (kept.length === 0) throw new DatabaseError("row_changed");

  // The columns the kept rows change (names only), in the order they first appear.
  const names = [...new Set(kept.flatMap((i) => sets[i]!.map((s) => s.column)))];
  const cells = kept.reduce((sum, i) => sum + sets[i]!.length, 0);
  const warnings = await bulkWarnings(db, change.table, table, TRIGGER_EVENT.update, kept.length);
  const referenced = referencedWarning(
    await listIncomingForeignKeys(db, table.oid),
    "update",
    names,
  );
  if (referenced) warnings.push(referenced);
  return {
    change,
    statements: kept.map((i) => buildUpdateRow(change.table, keys[i]!, sets[i]!, seen[i]!)),
    expect: "one_row",
    category: "row",
    effect: `Changes ${many(cells, "cell")} in ${many(kept.length, "row")} of ${displayName(change.table.schema, change.table.name)} (${listWords(names)}), each row found by its key, if its cells still hold the values you saw. All of them are changed or none is.${leftOutWords(skipped.length, change.rows.length)}`,
    warnings,
    destructive: false,
    guard: { relations: [guardRelation(table, [...key, ...names], "row_exclusive")] },
    skipped,
  };
}
