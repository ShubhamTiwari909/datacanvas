import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  captureStructure,
  diffStructures,
  diffToMarkdown,
  isDatabaseError,
  StructureTooLargeError,
} from "@datacanvas/database-core";
import { PostgresAdapter } from "@datacanvas/postgres-adapter";
import {
  MAX_SNAPSHOT_OBJECTS_PER_KIND,
  MAX_SNAPSHOT_TABLES,
  MAX_TABLES_PER_DETAILS_REQUEST,
  parsePostgresConnectionString,
  parseSnapshotFile,
} from "@datacanvas/shared-types";

const HELP = `Usage: datacanvas schema check --baseline <file> [--format markdown|json]

Compare an exported DataCanvas snapshot with a live PostgreSQL database.
Set DATACANVAS_DATABASE_URL to the database connection URL.
Exit codes: 0 matches, 1 drift detected, 2 check failed or comparison incomplete.`;

const MAX_BASELINE_BYTES = 20 * 1024 * 1024;

function failure(message: string): 2 {
  console.error(`Error: ${message}`);
  return 2;
}

async function readBaseline(file: string) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Expected a regular file.");
  if (info.size > MAX_BASELINE_BYTES) throw new Error("Baseline is too large.");
  // Read at most one byte over the limit in case the file grew after stat().
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file, { end: MAX_BASELINE_BYTES })) {
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  if (content.length > MAX_BASELINE_BYTES) throw new Error("Baseline is too large.");
  return content.toString("utf8");
}

export async function runSchemaCommand(args: string[]): Promise<0 | 1 | 2> {
  const [command, ...options] = args;
  if (command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  if (command !== "check") return failure(`Expected the schema check command.\n\n${HELP}`);

  let values;
  try {
    ({ values } = parseArgs({
      args: options,
      options: {
        baseline: { type: "string" },
        format: { type: "string", default: "markdown" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch {
    return failure(`Invalid schema check arguments.\n\n${HELP}`);
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.baseline) return failure(`Provide --baseline <file>.\n\n${HELP}`);
  if (values.format !== "markdown" && values.format !== "json") {
    return failure("Choose markdown or json for --format.");
  }

  const url = process.env.DATACANVAS_DATABASE_URL;
  if (!url?.trim()) return failure("Set DATACANVAS_DATABASE_URL to a PostgreSQL connection URL.");
  const connection = parsePostgresConnectionString(url);
  if (!connection.ok) return failure(connection.message);

  let text: string;
  try {
    text = await readBaseline(values.baseline);
  } catch {
    return failure("Cannot read the baseline. Use a regular snapshot file up to 20 MiB.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure("The baseline is not valid JSON.");
  }
  const baseline = parseSnapshotFile(raw);
  if (!baseline.ok) return failure(baseline.message);

  const adapter = new PostgresAdapter({ name: "Schema check", ...connection.value });
  try {
    await adapter.connect();
    const live = await captureStructure(adapter, {
      maxTables: MAX_SNAPSHOT_TABLES,
      maxObjectsPerKind: MAX_SNAPSHOT_OBJECTS_PER_KIND,
      schemaBatch: 8,
      detailsBatch: MAX_TABLES_PER_DETAILS_REQUEST,
    });
    const diff = diffStructures(baseline.snapshot.structure, live);
    const status = !diff.isEmpty ? "drift" : diff.objectsCompared ? "match" : "incomplete";
    if (values.format === "json") {
      console.log(JSON.stringify({ status, diff }));
    } else {
      console.log(diffToMarkdown(diff, { before: baseline.snapshot.name, after: "Live database" }));
    }
    if (status === "drift") return 1;
    if (status === "incomplete") {
      return failure(
        "The baseline lacks object metadata. Export a fresh snapshot to verify a match.",
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof StructureTooLargeError) {
      return failure(`The live database exceeds snapshot limits (${error.count} ${error.what}).`);
    }
    return failure(isDatabaseError(error) ? error.message : "Could not compare the live schema.");
  } finally {
    await adapter.disconnect();
  }
}
