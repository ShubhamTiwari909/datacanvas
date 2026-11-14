/**
 * Helpers for `DatabaseObjects`: one normal form, and the identity of each
 * kind of object.
 *
 * `normalizeObjects` is applied to whatever an adapter returns before it is
 * stored or compared: lists are sorted (by code unit, so every machine gives
 * the same order) and over-long definition text is cut (with a fingerprint of the whole text, so a change after the cut is still noticed). That keeps a snapshot
 * file stable and bounded however the database answered.
 *
 * The `*Key` functions say what makes two objects "the same object" in two
 * different structures (the diff matches by them): a function is its schema,
 * name and argument list (overloads are different functions), a trigger is its
 * table plus its name, and so on.
 */
import {
  MAX_OBJECT_TEXT,
  type DatabaseObjects,
  type ExtensionInfo,
  type FunctionInfo,
  type ObjectKind,
  type PolicyInfo,
  type RowSecurityInfo,
  type SequenceInfo,
  type TriggerInfo,
  type TypeInfo,
  type ViewInfo,
} from "./models.js";

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function emptyObjects(): DatabaseObjects {
  return {
    views: [],
    types: [],
    sequences: [],
    functions: [],
    triggers: [],
    extensions: [],
    policies: [],
    rowSecurity: [],
  };
}

/**
 * A fast 53-bit hash of text (cyrb53). Not cryptographic: it only has to make
 * a change to long text visible, and 53 bits make an accidental match between
 * two different texts of the same length negligible.
 */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The first `end` characters, without cutting an emoji or other surrogate pair in half. */
export function safeSlice(text: string, end: number): string {
  const last = end > 0 ? text.charCodeAt(end - 1) : 0;
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/**
 * Cut text longer than `MAX_OBJECT_TEXT`. The cut text ends with a note that
 * carries the full length and a fingerprint of the WHOLE text, so two long
 * definitions that agree for the first 20,000 characters and differ later still
 * come out different, and the diff reports the change instead of missing it.
 * The result is never longer than `MAX_OBJECT_TEXT`, and text that is already
 * short enough (including text cut earlier) comes back unchanged.
 */
export function clipText(text: string): string {
  if (text.length <= MAX_OBJECT_TEXT) return text;
  const note = `... [text cut: ${text.length} characters, fingerprint ${fingerprint(text)}]`;
  return safeSlice(text, MAX_OBJECT_TEXT - note.length) + note;
}
const clipNullable = (text: string | null): string | null =>
  text === null ? null : clipText(text);

const JOIN = "\u0000"; // cannot appear in a PostgreSQL identifier or argument list
const key = (...parts: string[]): string => parts.join(JOIN);

export const viewKey = (v: Pick<ViewInfo, "schema" | "name">): string => key(v.schema, v.name);
export const typeKey = (t: Pick<TypeInfo, "schema" | "name">): string => key(t.schema, t.name);
export const sequenceKey = (s: Pick<SequenceInfo, "schema" | "name">): string =>
  key(s.schema, s.name);
export const functionKey = (f: Pick<FunctionInfo, "schema" | "name" | "arguments">): string =>
  key(f.schema, f.name, f.arguments);
export const triggerKey = (t: Pick<TriggerInfo, "schema" | "table" | "name">): string =>
  key(t.schema, t.table, t.name);
export const extensionKey = (e: Pick<ExtensionInfo, "name">): string => e.name;
export const policyKey = (p: Pick<PolicyInfo, "schema" | "table" | "name">): string =>
  key(p.schema, p.table, p.name);
export const rowSecurityKey = (r: Pick<RowSecurityInfo, "schema" | "table">): string =>
  key(r.schema, r.table);

/** The name to show for each kind of object ("schema.name", a function with its arguments, a trigger with its table). */
export const displayName: {
  [K in ObjectKind]: (item: DatabaseObjects[K][number]) => string;
} = {
  views: (v) => `${v.schema}.${v.name}`,
  types: (t) => `${t.schema}.${t.name}`,
  sequences: (s) => `${s.schema}.${s.name}`,
  functions: (f) => `${f.schema}.${f.name}(${f.arguments})`,
  triggers: (t) => `${t.schema}.${t.table}.${t.name}`,
  extensions: (e) => e.name,
  policies: (p) => `${p.schema}.${p.table}.${p.name}`,
  rowSecurity: (r) => `${r.schema}.${r.table}`,
};

function sorted<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareText(keyOf(a), keyOf(b)));
}

export function normalizeObjects(objects: DatabaseObjects): DatabaseObjects {
  return {
    views: sorted(objects.views, viewKey).map((v) => ({
      ...v,
      definition: clipText(v.definition),
      dependsOn: sorted(v.dependsOn, (d) => key(d.schema, d.name)),
    })),
    types: sorted(objects.types, typeKey).map((t) => ({
      ...t,
      constraints: t.constraints.map(clipText),
      defaultValue: clipNullable(t.defaultValue),
    })),
    sequences: sorted(objects.sequences, sequenceKey),
    functions: sorted(objects.functions, functionKey).map((f) => ({
      ...f,
      definition: clipText(f.definition),
    })),
    triggers: sorted(objects.triggers, triggerKey).map((t) => ({
      ...t,
      definition: clipText(t.definition),
    })),
    extensions: sorted(objects.extensions, extensionKey),
    policies: sorted(objects.policies, policyKey).map((p) => ({
      ...p,
      roles: [...p.roles].sort(compareText),
      using: clipNullable(p.using),
      withCheck: clipNullable(p.withCheck),
    })),
    rowSecurity: sorted(objects.rowSecurity, rowSecurityKey),
  };
}
