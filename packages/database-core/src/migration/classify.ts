/**
 * What changing a column from one type to another costs and risks (decision 139, extended): which
 * conversions round or cut values (destructive), which can fail on rows that exist, which rewrite
 * the table, and whether PostgreSQL needs a `USING` expression. Pure, on the type text that
 * `format_type` prints (`"character varying(255)"`, `"numeric(10,2)"`, `"timestamp(3) with time zone"`).
 */
import type { Risk } from "./types.js";

export interface TypeChange {
  risk: Risk[];
  /** PostgreSQL has no assignment cast between the two: the statement needs `USING col::type`. */
  using: boolean;
  /** One plain sentence for the step, or null when there is nothing to add. */
  note: string | null;
}

interface Parsed {
  base: string;
  array: boolean;
  /** The numbers in the parentheses, if any: `(10,2)` is [10, 2], `(255)` is [255]. */
  mods: number[];
}

const INTEGERS = ["smallint", "integer", "bigint"];
const NUMERIC_LIKE = ["numeric", "real", "double precision", "money"];
const TEXT_LIKE = ["text", "character varying", "character", "citext"];
const TEMPORAL = [
  "date",
  "time without time zone",
  "time with time zone",
  "timestamp without time zone",
  "timestamp with time zone",
  "interval",
];

export function parseType(type: string): Parsed {
  let text = type.trim();
  const array = /\[\d*\]$/.test(text);
  text = text.replace(/(\[\d*\])+$/, "");
  const mods: number[] = [];
  const base = text
    .replace(/\(([^)]*)\)/, (_m, inner: string) => {
      for (const part of inner.split(",")) {
        const n = Number(part.trim());
        if (Number.isInteger(n)) mods.push(n);
      }
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { base, array, mods };
}

const sizeOf = (base: string): number => INTEGERS.indexOf(base);

/** Is the change between these two column types one that needs a look? Equal text is not a change. */
export function classifyTypeChange(from: string, to: string): TypeChange {
  const a = parseType(from);
  const b = parseType(to);
  const rewrite: Risk[] = ["lock", "rewrite"];

  if (a.array !== b.array) {
    return {
      risk: [...rewrite, "may_fail"],
      using: false,
      note: "An array and a single value: PostgreSQL may need a USING expression to convert it.",
    };
  }
  if (a.array && b.array && a.base !== b.base) {
    return {
      risk: [...rewrite, "may_fail"],
      using: false,
      note: "The type of the items changes: PostgreSQL may need a USING expression to convert them.",
    };
  }

  // integer -> integer: a wider one rewrites, a narrower one can fail on a value that does not fit
  // (an integer that does not fit is an error, never a quiet change).
  if (INTEGERS.includes(a.base) && INTEGERS.includes(b.base)) {
    return sizeOf(b.base) > sizeOf(a.base)
      ? { risk: rewrite, using: false, note: null }
      : {
          risk: [...rewrite, "may_fail"],
          using: false,
          note: "It fails if a value does not fit the narrower type.",
        };
  }

  // integer -> numeric: lossless when numeric is not constrained, else the digits must fit.
  if (INTEGERS.includes(a.base) && b.base === "numeric") {
    return b.mods.length > 0
      ? {
          risk: [...rewrite, "may_fail"],
          using: false,
          note: "It fails if a value has more digits than the new precision.",
        }
      : { risk: rewrite, using: false, note: null };
  }

  // numeric, real, double precision, money -> integer: the value is rounded.
  if (NUMERIC_LIKE.includes(a.base) && INTEGERS.includes(b.base)) {
    return {
      risk: [...rewrite, "may_fail", "destructive"],
      using: false,
      note: "Values are rounded to whole numbers, and it fails for a value out of range.",
    };
  }

  if (a.base === "numeric" && b.base === "numeric") {
    const [pa, sa] = [a.mods[0], a.mods[1] ?? 0];
    const [pb, sb] = [b.mods[0], b.mods[1] ?? 0];
    const unconstrainedBefore = pa === undefined;
    const unconstrainedAfter = pb === undefined;
    if (unconstrainedAfter) return { risk: ["lock"], using: false, note: null };
    if (unconstrainedBefore || sb < sa) {
      return {
        risk: [...rewrite, "may_fail", "destructive"],
        using: false,
        note: "Values with more decimals are rounded, and it fails for a value with too many digits.",
      };
    }
    if (pb < pa!) {
      return {
        risk: [...rewrite, "may_fail"],
        using: false,
        note: "It fails if a value has more digits than the new precision.",
      };
    }
    return sb === sa
      ? { risk: ["lock"], using: false, note: null }
      : { risk: rewrite, using: false, note: null };
  }

  if (a.base === "double precision" && b.base === "real") {
    return {
      risk: [...rewrite, "destructive"],
      using: false,
      note: "Values lose precision.",
    };
  }
  if (NUMERIC_LIKE.includes(a.base) && NUMERIC_LIKE.includes(b.base)) {
    return {
      risk: [...rewrite, "may_fail"],
      using: false,
      note: "It can fail or lose precision for some values.",
    };
  }

  // Text types: a longer or unconstrained one only needs the lock; a shorter one can fail on a long value.
  if (TEXT_LIKE.includes(a.base) && TEXT_LIKE.includes(b.base)) {
    if (a.base === "character" || b.base === "character") {
      return {
        risk: [...rewrite, ...(b.mods.length > 0 ? (["may_fail"] as Risk[]) : [])],
        using: false,
        note: "A fixed-length type pads its values with spaces.",
      };
    }
    const lengthBefore = a.mods[0];
    const lengthAfter = b.mods[0];
    if (lengthAfter === undefined || (lengthBefore !== undefined && lengthAfter >= lengthBefore)) {
      return { risk: ["lock"], using: false, note: null };
    }
    return {
      risk: ["lock", "may_fail"],
      using: false,
      note: "It fails if a value is longer than the new length (nothing is cut).",
    };
  }

  // Temporal.
  if (TEMPORAL.includes(a.base) && TEMPORAL.includes(b.base)) {
    if (a.base === b.base) {
      const before = a.mods[0] ?? 6;
      const after = b.mods[0] ?? 6;
      return after < before
        ? {
            risk: ["lock", "destructive"],
            using: false,
            note: "Fractions of a second are rounded.",
          }
        : { risk: ["lock"], using: false, note: null };
    }
    if (
      (a.base.startsWith("timestamp") && (b.base === "date" || b.base.startsWith("time "))) ||
      (a.base === "interval" && b.base !== "interval")
    ) {
      return {
        risk: [...rewrite, "destructive"],
        using: false,
        note: a.base.startsWith("timestamp")
          ? "The date or the time of day is dropped."
          : "The value is converted and may lose parts.",
      };
    }
    if (a.base.startsWith("timestamp") && b.base.startsWith("timestamp")) {
      return {
        risk: rewrite,
        using: false,
        note: "The conversion between a time with and without a time zone uses the session's time zone.",
      };
    }
    return { risk: rewrite, using: false, note: null };
  }

  // Into text: always possible, from anything.
  if (TEXT_LIKE.includes(b.base)) {
    return {
      risk: [...rewrite, ...(b.mods.length > 0 ? (["may_fail"] as Risk[]) : [])],
      using: false,
      note: null,
    };
  }

  // Out of text into another kind: PostgreSQL has no automatic cast, and the text may not parse.
  if (TEXT_LIKE.includes(a.base)) {
    return {
      risk: [...rewrite, "may_fail"],
      using: true,
      note: "The text is converted with USING, and it fails for a value that does not parse.",
    };
  }

  // Integer and boolean convert only explicitly.
  if (
    (INTEGERS.includes(a.base) && b.base === "boolean") ||
    (a.base === "boolean" && INTEGERS.includes(b.base))
  ) {
    return { risk: rewrite, using: true, note: "Converted with USING." };
  }

  return {
    risk: [...rewrite, "may_fail"],
    using: false,
    note: "PostgreSQL may need a USING expression to convert this.",
  };
}
