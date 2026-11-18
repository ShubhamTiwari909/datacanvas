/**
 * The fields of one column in the table builder (a new table, or "Add column"):
 * name, type from the allow-list with its length or precision, array, NULL,
 * default from a fixed list, identity and comment. Every field is labelled
 * with the column's position, so several columns on one screen stay distinct
 * for a screen reader.
 */
"use client";

import { useId } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIELD_HINT, FIELD_LABEL, WrappedField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SELECT_CLASS } from "@/components/ui/select";
import { ToggleButton } from "@/components/ui/toggle-button";
import {
  COLUMN_TYPE_NAMES,
  DEFAULT_LABEL,
  canBeIdentity,
  columnFormPatch,
  columnProblems,
  columnTypeOf,
  defaultKindsFor,
  takesLength,
  type ColumnForm,
} from "./structure";

/** Type, length or precision and scale, and array: shared by a new column and "Change type". */
export function TypeFields({
  form,
  onChange,
  prefix,
}: {
  form: Pick<ColumnForm, "typeName" | "length" | "precision" | "scale" | "array">;
  onChange: (next: Partial<ColumnForm>) => void;
  /** Prepended to every accessible name, e.g. "Column 2". */
  prefix: string;
}) {
  return (
    <div className="flex items-end gap-2">
      <WrappedField label="Type" className="min-w-0 flex-1">
        <select
          aria-label={`${prefix} type`}
          className={SELECT_CLASS}
          value={form.typeName}
          onChange={(event) => onChange({ typeName: event.target.value as ColumnForm["typeName"] })}
        >
          {COLUMN_TYPE_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </WrappedField>
      {takesLength(form.typeName) ? (
        <WrappedField label="Length" className="w-24">
          <Input
            aria-label={`${prefix} length`}
            inputMode="numeric"
            value={form.length}
            onChange={(event) => onChange({ length: event.target.value })}
          />
        </WrappedField>
      ) : null}
      {form.typeName === "numeric" ? (
        <>
          <WrappedField label="Precision" className="w-24">
            <Input
              aria-label={`${prefix} precision`}
              inputMode="numeric"
              value={form.precision}
              onChange={(event) => onChange({ precision: event.target.value })}
            />
          </WrappedField>
          <WrappedField label="Scale" className="w-20">
            <Input
              aria-label={`${prefix} scale`}
              inputMode="numeric"
              value={form.scale}
              onChange={(event) => onChange({ scale: event.target.value })}
            />
          </WrappedField>
        </>
      ) : null}
      <ToggleButton
        pressed={form.array}
        label="Array"
        name={`Array (${prefix})`}
        onClick={() => onChange({ array: !form.array })}
      />
    </div>
  );
}

/** A default, from the fixed list (no expressions, decision 124). */
export function DefaultFields({
  form,
  onChange,
  prefix,
  kinds,
}: {
  form: Pick<ColumnForm, "defaultKind" | "defaultValue" | "defaultBoolean">;
  onChange: (next: Partial<ColumnForm>) => void;
  prefix: string;
  kinds: ColumnForm["defaultKind"][];
}) {
  return (
    <div className="flex items-end gap-2">
      <WrappedField label="Default" className="min-w-0 flex-1">
        <select
          aria-label={`${prefix} default`}
          className={SELECT_CLASS}
          value={kinds.includes(form.defaultKind) ? form.defaultKind : "none"}
          onChange={(event) =>
            onChange({ defaultKind: event.target.value as ColumnForm["defaultKind"] })
          }
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {DEFAULT_LABEL[kind]}
            </option>
          ))}
        </select>
      </WrappedField>
      {form.defaultKind === "literal" ? (
        <WrappedField label="Default value" className="min-w-0 flex-1">
          <Input
            aria-label={`${prefix} default value`}
            value={form.defaultValue}
            onChange={(event) => onChange({ defaultValue: event.target.value })}
          />
        </WrappedField>
      ) : null}
      {form.defaultKind === "boolean" ? (
        <WrappedField label="Default value" className="min-w-0 flex-1">
          <select
            aria-label={`${prefix} default value`}
            className={SELECT_CLASS}
            value={form.defaultBoolean ? "true" : "false"}
            onChange={(event) => onChange({ defaultBoolean: event.target.value === "true" })}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </WrappedField>
      ) : null}
    </div>
  );
}

export function ColumnFields({
  form,
  index,
  onChange,
  onRemove,
}: {
  form: ColumnForm;
  /** 1-based position, for labels. */
  index: number;
  onChange: (next: Partial<ColumnForm>) => void;
  /** Absent when the column cannot be removed (the only column, or "Add column"). */
  onRemove?: () => void;
}) {
  const prefix = `Column ${index}`;
  const headingId = useId();
  // A change of type resets a default the new type does not offer, so the select never shows
  // "No default" while the form still holds `now()`.
  const change = (next: Partial<ColumnForm>) => onChange(columnFormPatch(form, next));
  const type = columnTypeOf(form);
  const identityAllowed = canBeIdentity(type);
  const problems = form.name === "" ? [] : columnProblems(form);
  return (
    <section
      role="group"
      aria-labelledby={headingId}
      data-slot="builder-card"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 id={headingId} className={FIELD_LABEL}>
          {prefix}
        </h4>
        <div className="flex items-center gap-1.5">
          {form.identity === null || !identityAllowed ? (
            <ToggleButton
              pressed={form.nullable}
              label="Can be NULL"
              name={`Can be NULL (${prefix})`}
              onClick={() => change({ nullable: !form.nullable })}
            />
          ) : null}
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onRemove}
              aria-label={`Remove ${prefix.toLowerCase()}`}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {/* Two columns on a 12-column grid: name, default and identity share the left edge, and type
          and comment share the right one. They stack on a narrow screen. */}
      <div className="grid grid-cols-12 gap-x-3 gap-y-3">
        <WrappedField label="Name" className="col-span-12 sm:col-span-6">
          <Input
            aria-label={`${prefix} name`}
            autoComplete="off"
            spellCheck={false}
            value={form.name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </WrappedField>
        <div className="col-span-12 sm:col-span-6">
          <TypeFields form={form} onChange={change} prefix={prefix} />
        </div>
        {/* Empty while an identity fills the column: kept on a wide screen so the comment stays under the type. */}
        <div
          className={
            form.identity === null || !identityAllowed
              ? "col-span-12 sm:col-span-6"
              : "col-span-6 hidden sm:block"
          }
        >
          {form.identity === null || !identityAllowed ? (
            <DefaultFields
              form={form}
              onChange={change}
              prefix={prefix}
              kinds={defaultKindsFor(type)}
            />
          ) : null}
        </div>
        <WrappedField label="Comment" className="col-span-12 sm:col-span-6">
          <Input
            aria-label={`${prefix} comment`}
            value={form.comment}
            onChange={(event) => change({ comment: event.target.value })}
          />
        </WrappedField>
        {identityAllowed ? (
          <WrappedField label="Identity" className="col-span-12 sm:col-span-6">
            <select
              aria-label={`${prefix} identity`}
              className={SELECT_CLASS}
              value={form.identity ?? "none"}
              onChange={(event) =>
                change({
                  identity:
                    event.target.value === "none"
                      ? null
                      : (event.target.value as "always" | "by_default"),
                })
              }
            >
              <option value="none">Not an identity</option>
              <option value="always">Generated always</option>
              <option value="by_default">Generated by default</option>
            </select>
            {form.identity !== null ? (
              <span className={FIELD_HINT}>Filled by the database, never NULL.</span>
            ) : null}
          </WrappedField>
        ) : null}
      </div>
      {problems.length > 0 ? (
        <ul className="text-xs text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
