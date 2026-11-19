/**
 * A plan as files (`docs/migration-studio-plan.md`, section 9): plain SQL, one file with dbmate or
 * goose markers, a Flyway pair, or `up.sql` and `down.sql`. A pure function of the plan, what the
 * person picked, a name and a moment: it reads no clock and writes nothing.
 *
 * Transactions. A file for `psql` carries its own `BEGIN` and `COMMIT`. A step PostgreSQL cannot run
 * in a transaction (`CREATE INDEX CONCURRENTLY`, a new enum label that may then be used) is written
 * outside it, in its place in the order, with a comment saying why; the steps around it are
 * transactions of their own. A runner (dbmate, goose, Flyway) wraps a migration in a transaction
 * itself, so a file for one carries no `BEGIN` unless it has such a step; then it asks the runner
 * for no transaction and keeps its own around the rest.
 *
 * A file made from a hostile database holds hostile text. Names and notes are cut to one line, held
 * SQL is commented out line by line, and a format whose runner reads comment lines as commands
 * (`-- migrate:`, `-- +goose`) is REFUSED when the migration holds such a line, since no quoting
 * would stop the runner from obeying it.
 */
import {
  buildScripts,
  flattenComment,
  resolveSelection,
  summarize,
  type Selection,
} from "./script.js";
import type { MigrationPlan, MigrationStep } from "./types.js";

export type ExportFormat = "sql" | "dbmate" | "goose" | "flyway" | "updown";

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; description: string }> = {
  sql: { label: "Plain SQL", description: "One file for psql, in a transaction." },
  dbmate: { label: "dbmate", description: "One file with -- migrate:up and -- migrate:down." },
  goose: { label: "goose", description: "One file with -- +goose Up and -- +goose Down." },
  flyway: { label: "Flyway", description: "A versioned file (V) and an undo file (U)." },
  updown: { label: "up.sql and down.sql", description: "Two plain files, each for psql." },
};

export interface ExportOptions {
  format: ExportFormat;
  /** What the person calls it; reduced to lowercase letters, digits and underscores. */
  name: string;
  /** The side the migration starts from and the side it makes it look like (shown in the header). */
  before: string;
  after: string;
  /** The moment of the file name, in the person's time. */
  at: Date;
}

export interface ExportFile {
  name: string;
  content: string;
  /** What it is for, in a few words. */
  role: "migration" | "undo" | "up" | "down";
}

export type ExportResult = { ok: true; files: ExportFile[] } | { ok: false; reason: string };

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `20261119143005`: the version a runner orders by. Local time, as the person sees it. */
export function exportTimestamp(at: Date): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/** A name safe in a file name and in a Flyway description: lowercase letters, digits, underscores. */
export function exportName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50)
    .replace(/_+$/g, "");
  return cleaned === "" ? "migration" : cleaned;
}

/**
 * What the runners read as a command: a comment line, white space of any kind allowed on both
 * sides of the dashes (their parsers trim with Unicode rules, and `\s` there spans line breaks),
 * then `+goose` or `migrate:`. Wider than any one parser on purpose.
 */
const RUNNER_COMMAND = /^[\s\u0085\u00a0\ufeff]*--[\s\u0085\u00a0\ufeff]*(\+goose|migrate:)/im;

const WHY_OUTSIDE =
  "PostgreSQL cannot run this inside a transaction block (or what it adds could not be used in the same transaction), so it runs on its own.";

interface Section {
  /** The statements, with the comments, in order. */
  text: string;
  /** True when some step in it must run outside a transaction. */
  outside: boolean;
}

const note = (s: MigrationStep, undo: boolean): string =>
  `-- ${undo ? "undo " : ""}${s.id}: ${flattenComment(s.note)}`;

/**
 * The steps as text. `wrap` puts `BEGIN` and `COMMIT` around each run of steps that can be in a
 * transaction; a step that cannot is written on its own between them. `goose` wraps each step in
 * the markers its parser needs for statements that hold semicolons.
 */
function section(
  plan: MigrationPlan,
  selection: Selection,
  direction: "up" | "down",
  options: { wrap: boolean; goose: boolean },
): Section {
  const { included } = resolveSelection(plan, selection.leftOut);
  const steps = direction === "up" ? included : [...included].reverse();
  const scripts = buildScripts(plan, selection);
  const held = new Set(scripts.held);
  const blocks: string[] = [];
  let open: string[] = [];
  let openActive = false;
  let outside = false;

  const wrapStep = (text: string): string =>
    options.goose ? `-- +goose StatementBegin\n${text}\n-- +goose StatementEnd` : text;
  const flush = (): void => {
    if (open.length > 0) {
      blocks.push(
        options.wrap && openActive
          ? `BEGIN;\n\n${open.join("\n\n")}\n\nCOMMIT;`
          : open.join("\n\n"),
      );
    }
    open = [];
    openActive = false;
  };

  for (const s of steps) {
    const sql = direction === "up" ? s.up : s.down;
    const label = note(s, direction === "down");
    if (sql === null) {
      open.push(`${label}\n-- This step cannot be undone.`);
      continue;
    }
    const isHeld = held.has(s.id);
    const body = isHeld
      ? `${label}\n-- NOT CONFIRMED (destroys data): confirm this step to run it.\n${sql
          .split(/\r\n|\r|\n/)
          .map((line) => `-- ${line}`)
          .join("\n")}`
      : `${label}\n${options.goose ? wrapStep(sql) : sql}`;
    if (direction === "up" && !isHeld && !s.transactional) {
      outside = true;
      flush();
      blocks.push(`-- ${WHY_OUTSIDE}\n${body}`);
      continue;
    }
    open.push(body);
    if (!isHeld) openActive = true;
  }
  flush();
  return { text: blocks.join("\n\n"), outside };
}

function header(
  plan: MigrationPlan,
  selection: Selection,
  options: ExportOptions,
  kind: "migration" | "rollback",
): string {
  const summary = summarize(plan, selection);
  const verdict =
    summary.reversibility === "full"
      ? "complete"
      : summary.reversibility === "partial"
        ? `partial (${summary.notFullyReversible} step${summary.notFullyReversible === 1 ? "" : "s"} cannot be fully undone)`
        : "none";
  const cut = (s: string) => flattenComment(s).slice(0, 200);
  const lines = [
    `-- Generated by DataCanvas from a comparison of ${cut(options.before)} and ${cut(options.after)}. This is the ${kind}.`,
    `-- It makes ${cut(options.before)} look like ${cut(options.after)}.`,
    "-- Read it before you run it: it contains definitions (views, functions) read from the databases it compares.",
    `-- ${summary.steps} step${summary.steps === 1 ? "" : "s"}; rollback: ${verdict}.`,
    ...(summary.unconfirmed > 0
      ? [
          `-- ${summary.unconfirmed} step${summary.unconfirmed === 1 ? "" : "s"} that destroy data are written commented out because they were not confirmed.`,
        ]
      : []),
    ...plan.warnings.map((w) => `-- Needs a person: ${flattenComment(w)}`),
    ...plan.notCompared.map((w) => `-- Not compared: ${flattenComment(w)}`),
  ];
  return lines.join("\n");
}

const psqlHint = "-- Run it with: psql -v ON_ERROR_STOP=1 -f <this file>";

export function buildExport(
  plan: MigrationPlan,
  selection: Selection,
  options: ExportOptions,
): ExportResult {
  const stamp = exportTimestamp(options.at);
  const name = exportName(options.name);
  const goose = options.format === "goose";
  const runner = options.format === "dbmate" || goose || options.format === "flyway";
  const hdr = (kind: "migration" | "rollback") => header(plan, selection, options, kind);
  const psql = (kind: "migration" | "rollback", text: string) =>
    `${hdr(kind)}\n${psqlHint}\n\n${text}\n`;

  // A runner obeys a comment line that looks like its command, whatever the line sits in (a quoted
  // name with a line break can start one). So the text that is ours to write, before the markers
  // are added, must hold no such line at all: nothing can be allow-listed by what it says.
  if (runner && options.format !== "flyway") {
    const raw = [
      hdr("migration"),
      hdr("rollback"),
      section(plan, selection, "up", { wrap: false, goose: false }).text,
      section(plan, selection, "down", { wrap: false, goose: false }).text,
    ].join("\n");
    if (RUNNER_COMMAND.test(raw)) {
      return {
        ok: false,
        reason: `A name or text in this migration holds a line that ${goose ? "goose" : "dbmate"} would read as one of its own commands, so it cannot be written for that runner. Choose another format.`,
      };
    }
  }

  // For psql the file carries its own transactions. For a runner it carries none, unless a step
  // cannot be in one: then the runner is told not to wrap it, and the file keeps its own.
  const outside = section(plan, selection, "up", { wrap: false, goose }).outside;
  const runnerUp = section(plan, selection, "up", { wrap: outside, goose }).text;
  const runnerDown = (wrap: boolean) => section(plan, selection, "down", { wrap, goose }).text;

  const files: ExportFile[] = [];
  switch (options.format) {
    case "sql":
      files.push({
        name: `migration-${stamp}-${name}.sql`,
        role: "migration",
        content: psql(
          "migration",
          section(plan, selection, "up", { wrap: true, goose: false }).text,
        ),
      });
      break;
    case "updown":
      files.push(
        {
          name: "up.sql",
          role: "up",
          content: psql(
            "migration",
            section(plan, selection, "up", { wrap: true, goose: false }).text,
          ),
        },
        {
          name: "down.sql",
          role: "down",
          content: psql(
            "rollback",
            section(plan, selection, "down", { wrap: true, goose: false }).text,
          ),
        },
      );
      break;
    case "dbmate":
      files.push({
        name: `${stamp}_${name}.sql`,
        role: "migration",
        content: `-- migrate:up${outside ? " transaction:false" : ""}\n${hdr("migration")}\n\n${runnerUp}\n\n-- migrate:down\n${hdr("rollback")}\n\n${runnerDown(false)}\n`,
      });
      break;
    case "goose":
      files.push({
        name: `${stamp}_${name}.sql`,
        role: "migration",
        content: `${outside ? "-- +goose NO TRANSACTION\n" : ""}-- +goose Up\n${hdr("migration")}\n\n${runnerUp}\n\n-- +goose Down\n${hdr("rollback")}\n\n${runnerDown(outside)}\n`,
      });
      break;
    case "flyway": {
      const upText = runnerUp;
      const downText = runnerDown(false);
      const placeholder = `${hdr("migration")}${upText}${hdr("rollback")}${downText}`.includes("${")
        ? "-- This file contains a dollar sign followed by a brace, which Flyway reads as a placeholder: set flyway.placeholderReplacement=false to run it.\n"
        : "";
      files.push(
        {
          name: `V${stamp}__${name}.sql`,
          role: "migration",
          content: `${hdr("migration")}\n${placeholder}\n${upText}\n`,
        },
        {
          name: `U${stamp}__${name}.sql`,
          role: "undo",
          content: `${hdr("rollback")}\n${placeholder}\n${downText}\n`,
        },
      );
      break;
    }
  }

  return { ok: true, files };
}
