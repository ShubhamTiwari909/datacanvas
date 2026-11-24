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

/** A document a client may read (`resources/read`): the server decides what exists, and for whom, from the context. */
export interface ListedResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceCatalog<Context> {
  /** The resources this caller may see. */
  list(context: Context): ReadonlyArray<ListedResource>;
  /**
   * The text of one resource, or null when there is none by that uri (for this caller).
   * @throws ToolError for words meant for the model.
   */
  read(uri: string, context: Context, signal?: CancelSignal): Promise<string | null>;
}

/** What a prompt asks of its user (a name and what it is). */
export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface ListedPrompt {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
}

export interface PromptDefinition<Context> extends ListedPrompt {
  /** The text the prompt sends as the user's message; it holds the arguments' text and no value of any database. */
  text(args: Record<string, string>, context: Context): string;
}
