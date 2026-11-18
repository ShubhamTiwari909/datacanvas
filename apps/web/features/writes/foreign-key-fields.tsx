/**
 * A foreign key, chosen from what exists: the columns of this table, then a
 * schema, a table and its columns (read from the explorer), and what happens on
 * delete and on update. For a new table, the table may point at itself.
 */
"use client";

import { Fragment, useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ReferentialAction } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import { FIELD_LABEL, WrappedField } from "@/components/ui/field";
import { useAsyncData } from "@/lib/use-async-data";
import { useStructureVersion } from "@/stores/writes-store";
import { SELECT_CLASS } from "@/components/ui/select";
import { sharedSchemas, sharedTableDetails, sharedTables } from "./fk-lookups";
import { ACTIONS, ACTION_LABEL, type ForeignKeyForm } from "./structure";

/** The new table itself, when a foreign key of a table being created points at its own columns. */
export interface SelfTable {
  schema: string;
  name: string;
  columns: string[];
}

export function ForeignKeyFields({
  connectionId,
  form,
  index,
  localColumns,
  self,
  onChange,
  onRemove,
}: {
  connectionId: string;
  form: ForeignKeyForm;
  index: number;
  /** The columns of the table that holds the foreign key. */
  localColumns: string[];
  self?: SelfTable;
  onChange: (next: Partial<ForeignKeyForm>) => void;
  onRemove?: () => void;
}) {
  const headingId = useId();
  const prefix = `Foreign key ${index}`;
  // The lists are shared between the foreign key rows (one request, not one per row) and read again
  // after a change of structure.
  const version = useStructureVersion(connectionId);
  const schemas = useAsyncData(
    () => sharedSchemas(connectionId, version),
    `${connectionId}/fk-schemas/${version}`,
  );
  const tables = useAsyncData(
    () => sharedTables(connectionId, version, form.schema),
    `${connectionId}/fk-tables/${version}/${form.schema}`,
  );
  const pointsAtSelf =
    self !== undefined &&
    self.name !== "" &&
    form.schema === self.schema &&
    form.table === self.name;
  const target = useAsyncData(
    () =>
      form.table === "" || pointsAtSelf
        ? Promise.resolve({ ok: true as const, data: null })
        : sharedTableDetails(connectionId, version, form.schema, form.table),
    `${connectionId}/fk-target/${version}/${form.schema}/${form.table}/${pointsAtSelf}`,
  );

  const schemaNames =
    schemas.state.status === "success" ? schemas.state.data.map((s) => s.name) : [form.schema];
  const tableNames = [
    ...(self && self.name !== "" && form.schema === self.schema ? [self.name] : []),
    ...(tables.state.status === "success"
      ? tables.state.data.filter((t) => t.kind === "table").map((t) => t.name)
      : []),
  ];
  const targetColumns = pointsAtSelf
    ? (self?.columns ?? [])
    : target.state.status === "success" && target.state.data
      ? target.state.data.columns.map((c) => c.name)
      : [];

  const setPair = (position: number, local: string | null, referenced: string | null) => {
    const columns = [...form.columns];
    const refs = [...form.referenced];
    if (local !== null) columns[position] = local;
    if (referenced !== null) refs[position] = referenced;
    onChange({ columns, referenced: refs });
  };

  return (
    <section
      role="group"
      aria-labelledby={headingId}
      data-slot="builder-card"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between">
        <h4 id={headingId} className={FIELD_LABEL}>
          {prefix}
        </h4>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label={`Remove ${prefix.toLowerCase()}`}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {/* The same 12-column grid as a column card: a column and the schema share a left edge, and
          so do "points at" and the table. */}
      <div className="grid grid-cols-12 gap-x-3 gap-y-3">
        <WrappedField label="Points at schema" className="col-span-12 sm:col-span-6">
          <select
            aria-label={`${prefix} schema`}
            className={SELECT_CLASS}
            value={form.schema}
            onChange={(event) =>
              onChange({
                schema: event.target.value,
                table: "",
                referenced: form.referenced.map(() => ""),
              })
            }
          >
            {schemaNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </WrappedField>
        <WrappedField label="Table" className="col-span-12 sm:col-span-6">
          <select
            aria-label={`${prefix} table`}
            className={SELECT_CLASS}
            value={form.table}
            onChange={(event) =>
              onChange({ table: event.target.value, referenced: form.referenced.map(() => "") })
            }
          >
            <option value="">Choose a table</option>
            {tableNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </WrappedField>

        {form.columns.map((local, position) => (
          <Fragment key={position}>
            <WrappedField label="Column" className="col-span-12 sm:col-span-6">
              <select
                aria-label={`${prefix} column ${position + 1}`}
                className={SELECT_CLASS}
                value={local}
                onChange={(event) => setPair(position, event.target.value, null)}
              >
                <option value="">Choose a column</option>
                {localColumns
                  .filter((c) => c !== "")
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </select>
            </WrappedField>
            <WrappedField label="Points at" className="col-span-10 sm:col-span-5">
              <select
                aria-label={`${prefix} referenced column ${position + 1}`}
                className={SELECT_CLASS}
                value={form.referenced[position] ?? ""}
                onChange={(event) => setPair(position, null, event.target.value)}
              >
                <option value="">Choose a column</option>
                {targetColumns.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </WrappedField>
            <div className="col-span-2 flex items-end justify-end sm:col-span-1">
              {form.columns.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove column pair ${position + 1} of ${prefix.toLowerCase()}`}
                  onClick={() =>
                    onChange({
                      columns: form.columns.filter((_, i) => i !== position),
                      referenced: form.referenced.filter((_, i) => i !== position),
                    })
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </Fragment>
        ))}

        <div className="col-span-12">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              onChange({ columns: [...form.columns, ""], referenced: [...form.referenced, ""] })
            }
          >
            <Plus aria-hidden="true" />
            Add a column pair
            <span className="sr-only"> to {prefix.toLowerCase()}</span>
          </Button>
        </div>

        {(["onDelete", "onUpdate"] as const).map((field) => (
          <WrappedField
            key={field}
            label={field === "onDelete" ? "On delete" : "On update"}
            className="col-span-12 sm:col-span-6"
          >
            <select
              aria-label={`${prefix} ${field === "onDelete" ? "on delete" : "on update"}`}
              className={SELECT_CLASS}
              value={form[field]}
              onChange={(event) => onChange({ [field]: event.target.value as ReferentialAction })}
            >
              {ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABEL[action]}
                </option>
              ))}
            </select>
          </WrappedField>
        ))}
      </div>
    </section>
  );
}
