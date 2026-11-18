/**
 * Form fields with one type scale and one rhythm (docs/ui-polish-plan.md, U1).
 *
 *   section label   14 px / 500   (a group heading: `FIELD_SECTION`)
 *   field label     13 px / 500
 *   meta            12 px mono, muted: the column type beside a label
 *   hint and error  12 px
 *
 * 6 px between a label and its control, 4 px to the hint, 16 px between fields
 * (`FormStack`). Nothing here is below 12 px.
 */
"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const FIELD_LABEL = "text-[13px] leading-5 font-medium text-foreground";
export const FIELD_SECTION = "text-sm leading-5 font-medium text-foreground";
export const FIELD_META = "font-mono text-xs leading-5 text-muted-foreground";
export const FIELD_HINT = "text-xs leading-4 text-muted-foreground";
export const FIELD_ERROR = "text-xs leading-4 text-destructive";

/** The fields of a form, 16 px apart. */
export function FormStack({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="form-stack" className={cn("flex flex-col gap-4", className)} {...props} />;
}

/** What a control needs to be tied to its label, hint and error. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * A label, a control, and an optional hint and error, wired together: the label
 * names the control, and the hint and error describe it (`aria-describedby`).
 * The control is a render prop so any input can take the props:
 *
 *   <FormField label="Name" hint="At most 63 bytes.">
 *     {(field) => <Input {...field} value={...} onChange={...} />}
 *   </FormField>
 */
export function FormField({
  label,
  meta,
  hint,
  error,
  alertOnError = false,
  className,
  children,
}: {
  label: ReactNode;
  /** Small monospace text after the label, such as the column's type. */
  meta?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Announce the error when it appears: for an answer from the server, not for checks made while typing. */
  alertOnError?: boolean;
  className?: string;
  children: (field: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");
  return (
    <div data-slot="form-field" className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
        {meta ? <span className={FIELD_META}>{meta}</span> : null}
      </div>
      {children({
        id,
        "aria-describedby": describedBy === "" ? undefined : describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {error ? (
        <p id={errorId} role={alertOnError ? "alert" : undefined} className={FIELD_ERROR}>
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className={FIELD_HINT}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A field whose label wraps its control (the control carries its own accessible
 * name, so the label text is visual). Used in dense rows such as a column card.
 */
export function WrappedField({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  );
}
