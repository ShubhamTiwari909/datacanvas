/**
 * The in-place editor of one grid cell (`docs/write-side-v2-plan.md`, section 5): the same value field as the row
 * form (NULL apart from the empty string, a switch for a boolean, JSON, long text shown on one line until opened).
 * Enter, or leaving the editor, keeps the value as a pending change; Escape puts the cell back as it was. Nothing is
 * sent from here: the pending changes are reviewed and previewed together.
 */
"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { RowColumn } from "@datacanvas/database-core";
import { FIELD_ERROR } from "@/components/ui/field";
import { useBlurStore } from "@/features/data/blur-store";
import { checkValue } from "./row-edit";
import { ValueField, type ValueState } from "./value-field";

export function CellEditor({
  column,
  value,
  original,
  nullable,
  onCommit,
  onCancel,
}: {
  column: RowColumn;
  /** What the cell holds now (a pending value, or what was read). */
  value: string | null;
  /** The value as it was read, for the JSON editor's Changes view. */
  original: string | null;
  nullable: boolean;
  /** `refocus` is false when the value was kept because focus left the editor for something else. */
  onCommit: (value: string | null, refocus: boolean) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const blurred = useBlurStore((s) => s.blurred);
  const [state, setState] = useState<ValueState>(
    value === null ? { mode: "null", text: "" } : { mode: "value", text: value },
  );
  // Set once the editor is done, so the blur that follows a commit or a cancel does not commit again.
  const done = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const next = state.mode === "null" ? null : state.text;
  const problem = state.mode === "value" ? checkValue(column.dataType, state.text) : null;

  const commit = (refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    onCommit(next, refocus);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys of a dialog opened from here (the JSON editor) reach this handler through React; they are not ours.
    if (!box.current?.contains(event.target as Node)) return;
    // The grid moves between cells with the arrow keys: inside the editor they move the caret.
    event.stopPropagation();
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    const target = event.target as HTMLElement;
    // Enter on a button (NULL, the eye, JSON) presses it; on a switch or a field it keeps the value, and Ctrl or
    // Cmd plus Enter keeps it from anywhere in the editor.
    const anywhere = event.ctrlKey || event.metaKey;
    if (!anywhere && target.tagName === "BUTTON" && target.getAttribute("role") !== "switch")
      return;
    event.preventDefault();
    commit(true);
  };

  return (
    <div
      ref={box}
      role="group"
      aria-label={`Edit ${column.name}`}
      className="flex min-w-56 flex-col gap-1"
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        const to = event.relatedTarget as Node | null;
        // Still inside the editor, or in a dialog opened from it: not done yet.
        if (to && (box.current?.contains(to) || (to as Element).closest?.('[role="dialog"]')))
          return;
        commit(false);
      }}
    >
      <ValueField
        field={{
          id,
          "aria-describedby": `${id}-hint${problem ? ` ${id}-error` : ""}`,
          ...(problem ? { "aria-invalid": true as const } : {}),
        }}
        dataType={column.dataType}
        column={column.name}
        state={state}
        offers={{ null: nullable, default: false }}
        ariaLabel={`New value of ${column.name}`}
        autoFocus
        blurred={blurred}
        jsonOriginal={original}
        onChange={setState}
      />
      <p id={`${id}-hint`} className="sr-only">
        Enter keeps the change, Escape cancels it. Shift+Enter starts a new line, and Ctrl+Enter
        keeps the change from a button.
      </p>
      {problem ? (
        <p id={`${id}-error`} className={`${FIELD_ERROR} whitespace-normal`}>
          {problem}
        </p>
      ) : null}
    </div>
  );
}
