/**
 * "New table": a form for the table's name, columns, primary key, unique
 * constraints, foreign keys and comment. Nothing is typed as SQL: types and
 * defaults come from fixed lists and foreign keys from existing tables. The
 * server builds the `CREATE TABLE` and shows it in the preview before anything
 * runs (decisions 124 and 127).
 */
"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { afterStructureChange } from "./after-structure-change";
import { ChangeDialog, type ChangeRequest } from "./change-dialog";
import { ColumnFields } from "./column-fields";
import { ForeignKeyFields } from "./foreign-key-fields";
import {
  buildCreateTable,
  createTableProblems,
  newColumnForm,
  newForeignKeyForm,
  removeColumnIn,
  renameColumnIn,
  renameTableIn,
  type CreateTableForm,
} from "./structure";

function initialForm(schema: string): CreateTableForm {
  return {
    schema,
    name: "",
    columns: [
      newColumnForm({ name: "id", typeName: "bigint", identity: "always", nullable: false }),
    ],
    primaryKey: ["id"],
    unique: [],
    foreignKeys: [],
    comment: "",
  };
}

export function CreateTableDialog({
  connectionId,
  schema,
  onClose,
}: {
  connectionId: string;
  /** The schema to create the table in; null when the dialog is closed. */
  schema: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={schema !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {schema !== null ? (
          <NewTableForm
            key={schema}
            connectionId={connectionId}
            schema={schema}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewTableForm({
  connectionId,
  schema,
  onClose,
}: {
  connectionId: string;
  schema: string;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CreateTableForm>(() => initialForm(schema));
  const [request, setRequest] = useState<ChangeRequest | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const selectTable = useWorkspaceStore((s) => s.selectTable);
  const problems = createTableProblems(form);
  const names = form.columns.map((c) => c.name).filter((n) => n !== "");

  const update = (next: Partial<CreateTableForm>) => setForm((f) => ({ ...f, ...next }));

  const toggleIn = (list: string[], name: string, on: boolean) =>
    on ? [...list.filter((n) => n !== name), name] : list.filter((n) => n !== name);

  return (
    <>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setShowProblems(true);
          if (problems.length > 0) return;
          setRequest({
            change: buildCreateTable(form),
            title: `Create ${schema}.${form.name}`,
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>New table in {schema}</DialogTitle>
          <DialogDescription>
            Define the table. You will see the exact statement before anything is created.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-3">
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <Label htmlFor="create-table-name">Table name</Label>
            <Input
              id="create-table-name"
              autoComplete="off"
              spellCheck={false}
              value={form.name}
              // A foreign key that points at the table itself moves with its name.
              onChange={(event) => setForm((f) => renameTableIn(f, event.target.value))}
            />
          </div>
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <Label htmlFor="create-table-comment">Comment (optional)</Label>
            <Input
              id="create-table-comment"
              value={form.comment}
              onChange={(event) => update({ comment: event.target.value })}
            />
          </div>
        </div>

        <section aria-labelledby="create-columns" className="flex flex-col gap-2">
          <h3 id="create-columns" className="text-sm font-medium">
            Columns
          </h3>
          {form.columns.map((column, index) => (
            <ColumnFields
              key={column.id}
              form={column}
              index={index + 1}
              onChange={(next) =>
                setForm((f) => {
                  // A renamed column keeps its place in the primary key, the unique constraints
                  // and the foreign keys.
                  const { name, ...rest } = next;
                  const renamed = name !== undefined ? renameColumnIn(f, column.id, name) : f;
                  return {
                    ...renamed,
                    columns: renamed.columns.map((c) =>
                      c.id === column.id ? { ...c, ...rest } : c,
                    ),
                  };
                })
              }
              onRemove={
                form.columns.length > 1
                  ? () => setForm((f) => removeColumnIn(f, column.id))
                  : undefined
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => update({ columns: [...form.columns, newColumnForm()] })}
          >
            <Plus aria-hidden="true" />
            Add a column
          </Button>
        </section>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Primary key</legend>
          {names.length === 0 ? (
            <p className="text-xs text-muted-foreground">Name a column first.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {names.map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={form.primaryKey.includes(name)}
                    onChange={(event) =>
                      update({ primaryKey: toggleIn(form.primaryKey, name, event.target.checked) })
                    }
                  />
                  <span className="font-mono">{name}</span>
                  <span className="sr-only"> in the primary key</span>
                </label>
              ))}
            </div>
          )}
          {form.primaryKey.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Without a primary key (or a unique index on columns that cannot be NULL), the rows of
              this table cannot be edited in DataCanvas.
            </p>
          ) : null}
        </fieldset>

        <section aria-labelledby="create-unique" className="flex flex-col gap-2">
          <h3 id="create-unique" className="text-sm font-medium">
            Unique constraints
          </h3>
          {form.unique.map((set, index) => (
            <fieldset
              key={index}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-2"
            >
              <legend className="px-1 text-xs">Unique constraint {index + 1}</legend>
              {names.map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={set.includes(name)}
                    onChange={(event) =>
                      update({
                        unique: form.unique.map((s, i) =>
                          i === index ? toggleIn(s, name, event.target.checked) : s,
                        ),
                      })
                    }
                  />
                  <span className="font-mono">{name}</span>
                  <span className="sr-only"> in unique constraint {index + 1}</span>
                </label>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                aria-label={`Remove unique constraint ${index + 1}`}
                onClick={() => update({ unique: form.unique.filter((_, i) => i !== index) })}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => update({ unique: [...form.unique, []] })}
          >
            <Plus aria-hidden="true" />
            Add a unique constraint
          </Button>
        </section>

        <section aria-labelledby="create-fks" className="flex flex-col gap-2">
          <h3 id="create-fks" className="text-sm font-medium">
            Foreign keys
          </h3>
          {form.foreignKeys.map((fk, index) => (
            <ForeignKeyFields
              key={fk.id}
              connectionId={connectionId}
              form={fk}
              index={index + 1}
              localColumns={names}
              self={{ schema, name: form.name, columns: names }}
              onChange={(next) =>
                update({
                  foreignKeys: form.foreignKeys.map((f) =>
                    f.id === fk.id ? { ...f, ...next } : f,
                  ),
                })
              }
              onRemove={() =>
                update({ foreignKeys: form.foreignKeys.filter((f) => f.id !== fk.id) })
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              update({ foreignKeys: [...form.foreignKeys, newForeignKeyForm(schema)] })
            }
          >
            <Plus aria-hidden="true" />
            Add a foreign key
          </Button>
        </section>

        {showProblems && problems.length > 0 ? (
          <ul
            role="alert"
            aria-label="Problems"
            className="flex flex-col gap-1 text-sm text-destructive"
          >
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Preview</Button>
        </DialogFooter>
      </form>

      <ChangeDialog
        connectionId={connectionId}
        request={request}
        onClose={() => setRequest(null)}
        onApplied={(_result, change) => {
          setRequest(null);
          onClose();
          void afterStructureChange(connectionId, change).then(() =>
            selectTable({ schema, name: form.name }),
          );
        }}
      />
    </>
  );
}
