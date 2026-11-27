/** How the write editors handle line endings in browser text fields. */

export const CARRIAGE_RETURN_TEXT =
  "This value has Windows line endings (or a bare carriage return), which this editor cannot keep exactly.";

/**
 * A text field gives its value back with every CRLF and bare CR turned into LF, so editing such a value would
 * rewrite line endings the person never touched while the change is checked against the original. Such a value is
 * not edited here.
 */
export const hasCarriageReturn = (value: string | null): boolean =>
  value !== null && value.includes("\r");

/** Line endings as a text field returns them: CRLF and CR become LF. */
export const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, "\n");

/**
 * Is `next` the value `original` already is? It is when they are equal, or when they differ only by the
 * normalization of line endings (the field's, not the person's, doing): that is not a change.
 */
export function isSameText(original: string | null, next: string | null): boolean {
  if (original === next) return true;
  if (original === null || next === null) return false;
  return hasCarriageReturn(original) && normalizeLineEndings(original) === next;
}
