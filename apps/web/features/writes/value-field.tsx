/**
 * The control for one column's value in the row forms (docs/ui-polish-plan.md, U2).
 *
 * The control fits the type: a switch for a boolean, a one-line field for a
 * number, a date or a UUID, and a field that grows with its text for the rest.
 * NULL and "leave it to the default" are small buttons beside the control
 * rather than radios or a checkbox below it, so a field is one row high and the
 * form keeps one rhythm. Typing in the control makes it a value again.
 */
"use client";

import type { FieldControlProps } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleButton } from "@/components/ui/toggle-button";
import { BLUR_CLASSES } from "@/features/data/blur-store";
import { cn } from "@/lib/utils";
import { controlKind, isTrueText, type InsertMode } from "./row-edit";

export interface ValueState {
  mode: InsertMode;
  /** Kept while the mode is NULL or default, so pressing the button again brings it back. */
  text: string;
}

export function ValueField({
  field,
  dataType,
  column,
  state,
  offers,
  defaultText,
  ariaLabel,
  autoFocus = false,
  locked = false,
  blurred,
  onChange,
}: {
  /** From the surrounding `FormField`. */
  field: FieldControlProps;
  dataType: string;
  column: string;
  state: ValueState;
  /** Which of the two buttons the column offers. */
  offers: { null: boolean; default: boolean };
  /** What the field says while the column is left to its default. */
  defaultText?: string;
  /** Overrides the accessible name the label would give. */
  ariaLabel?: string;
  autoFocus?: boolean;
  /** The database always fills this column: shown, never editable. */
  locked?: boolean;
  blurred: boolean;
  onChange: (next: ValueState) => void;
}) {
  const kind = controlKind(dataType);
  const active = state.mode === "value";
  const placeholder =
    state.mode === "null"
      ? "NULL"
      : state.mode === "default"
        ? (defaultText ?? "Default")
        : undefined;
  const type = (text: string) => onChange({ mode: "value", text });

  let control: React.ReactNode;
  if (kind === "boolean") {
    const on = active && isTrueText(state.text);
    control = (
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2.5">
        <Switch
          id={field.id}
          aria-describedby={field["aria-describedby"]}
          aria-label={ariaLabel}
          checked={on}
          disabled={locked}
          onCheckedChange={(checked) => type(checked ? "true" : "false")}
        />
        <span className={cn("text-sm", active ? "font-mono" : "text-muted-foreground")}>
          {active ? (on ? "true" : "false") : placeholder}
        </span>
      </div>
    );
  } else if (kind === "text") {
    control = (
      <Textarea
        {...field}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        rows={Math.min(6, Math.max(1, state.text.split("\n").length))}
        disabled={locked || state.mode === "null"}
        value={active ? state.text : ""}
        placeholder={placeholder}
        onChange={(event) => type(event.target.value)}
        className={cn("min-w-0 flex-1 font-mono", blurred && BLUR_CLASSES)}
      />
    );
  } else {
    control = (
      <Input
        {...field}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        inputMode={
          kind === "number"
            ? /^(smallint|integer|bigint)\b/i.test(dataType)
              ? "numeric"
              : "decimal"
            : undefined
        }
        disabled={locked || state.mode === "null"}
        value={active ? state.text : ""}
        placeholder={placeholder}
        onChange={(event) => type(event.target.value)}
        className={cn("min-w-0 flex-1 font-mono", blurred && BLUR_CLASSES)}
      />
    );
  }

  return (
    <div className="flex items-start gap-2">
      {control}
      {offers.default || offers.null ? (
        <div className="flex shrink-0 items-start gap-1.5">
          {offers.default ? (
            <ToggleButton
              pressed={state.mode === "default"}
              label="Default"
              name={`Default for ${column}`}
              onClick={() =>
                onChange({ mode: state.mode === "default" ? "value" : "default", text: state.text })
              }
            />
          ) : null}
          {offers.null ? (
            <ToggleButton
              pressed={state.mode === "null"}
              label="NULL"
              name={`NULL for ${column}`}
              onClick={() =>
                onChange({ mode: state.mode === "null" ? "value" : "null", text: state.text })
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
