/**
 * The fields of one column in the table builder (a new table, or "Add column"):
 * name, type from the allow-list with its length or precision, array, NULL,
 * default from a fixed list, identity and comment. Every field is labelled
 * with the column's position, so several columns on one screen stay distinct
 * for a screen reader.
 */
"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIELD_LABEL, WrappedField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SELECT_CLASS } from "@/components/ui/select";
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
    <>
      <WrappedField label="Type">
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
      <label className="flex items-center gap-1.5 self-end pb-2 text-xs">
        <input
          type="checkbox"
          checked={form.array}
          onChange={(event) => onChange({ array: event.target.checked })}
        />
        Array
        <span className="sr-only"> ({prefix})</span>
      </label>
    </>
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
    <>
      <WrappedField label="Default">
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
        <WrappedField label="Default value">
          <Input
            aria-label={`${prefix} default value`}
            value={form.defaultValue}
            onChange={(event) => onChange({ defaultValue: event.target.value })}
          />
        </WrappedField>
      ) : null}
      {form.defaultKind === "boolean" ? (
        <WrappedField label="Default value">
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
    </>
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
  // A change of type resets a default the new type does not offer, so the select never shows
  // "No default" while the form still holds `now()`.
  const change = (next: Partial<ColumnForm>) => onChange(columnFormPatch(form, next));
  const type = columnTypeOf(form);
  const identityAllowed = canBeIdentity(type);
  const problems = form.name === "" ? [] : columnProblems(form);
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
      <legend className={`px-1 ${FIELD_LABEL}`}>{prefix}</legend>
      <div className="flex flex-wrap items-end gap-2">
        <WrappedField label="Name" className="min-w-40 flex-1">
          <Input
            aria-label={`${prefix} name`}
            autoComplete="off"
            spellCheck={false}
            value={form.name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </WrappedField>
        <TypeFields form={form} onChange={change} prefix={prefix} />
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mb-0.5"
            onClick={onRemove}
            aria-label={`Remove ${prefix.toLowerCase()}`}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {identityAllowed ? (
          <WrappedField label="Identity">
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
          </WrappedField>
        ) : null}
        {form.identity === null || !identityAllowed ? (
          <>
            <DefaultFields
              form={form}
              onChange={change}
              prefix={prefix}
              kinds={defaultKindsFor(type)}
            />
            <label className="flex items-center gap-1.5 self-end pb-2 text-xs">
              <input
                type="checkbox"
                checked={form.nullable}
                onChange={(event) => change({ nullable: event.target.checked })}
              />
              Can be NULL
              <span className="sr-only"> ({prefix})</span>
            </label>
          </>
        ) : (
          <p className="self-end pb-2 text-xs text-muted-foreground">
            Filled by the database, never NULL.
          </p>
        )}
        <WrappedField label="Comment" className="min-w-40 flex-1">
          <Input
            aria-label={`${prefix} comment`}
            value={form.comment}
            onChange={(event) => change({ comment: event.target.value })}
          />
        </WrappedField>
      </div>
      {problems.length > 0 ? (
        <ul className="text-xs text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
