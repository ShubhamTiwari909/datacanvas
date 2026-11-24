/**
 * What a tool is (`docs/mcp-server-plan.md`, section 4): a name, a description written for a model, a STRICT input schema,
 * the annotations that say it only reads, and a function that runs it. The list is data, so a test can pin it: a new tool is
 * a deliberate change of that test, a decision and a review.
 */
import type { z } from "zod";

/** The annotations every tool of DataCanvas carries: it reads, it changes nothing, it reaches nothing outside. */
export interface ReadOnlyAnnotations {
  readOnlyHint: true;
  destructiveHint: false;
  /** Calling it again with the same input gives the same effect (none): true for every read. */
  idempotentHint: true;
  openWorldHint: false;
}

export const READ_ONLY: ReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** What a tool answers: text for the model, the same data as structure, and whether it is an error the model can act on. */
export interface ToolResult {
  text: string;
  data?: unknown;
  isError?: boolean;
}

/** An error whose message is meant for the model and the person: fixed words that repeat no value. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** The part of an `AbortSignal` a tool looks at (this package has no DOM or Node types). */
export interface CancelSignal {
  readonly aborted: boolean;
}

export interface ToolDefinition<Context> {
  name: string;
  title: string;
  /** For a model: what it is for, its limits, and what it never returns. */
  description: string;
  /** Strict: an unknown field is refused, not ignored. */
  input: z.ZodObject;
  annotations: ReadOnlyAnnotations;
  run(args: unknown, context: Context, signal?: CancelSignal): Promise<ToolResult>;
}

/** A tool as it is listed to a client. */
export interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ReadOnlyAnnotations;
}
