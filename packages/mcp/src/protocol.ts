/**
 * The Model Context Protocol, tools only, as a pure function from a request body to an answer (`docs/mcp-server-plan.md`,
 * sections 4 and 5; decision 169). It speaks `initialize`, `ping`, `tools/list` and `tools/call`, over JSON-RPC 2.0; any
 * other method is "method not found", and the server declares no resources, no prompts and no logging, so a client does
 * not ask for them. It is stateless (no session), has no network code and no framework: a route hands it a parsed body and
 * a context and sends what it returns.
 *
 * Every error answer is a fixed sentence that repeats nothing the client sent, and a tool's own failure is a tool RESULT
 * (`isError`), never an exception that could carry a value.
 */
import { z } from "zod";
import {
  ERROR,
  MAX_BATCH,
  classify,
  failure,
  success,
  type JsonRpcResponse,
  type RequestId,
} from "./jsonrpc.js";
import {
  ToolError,
  type CancelSignal,
  type ListedTool,
  type ToolDefinition,
  type ToolResult,
} from "./tools.js";

/** The protocol versions this server speaks, newest first. A client asking for another gets the newest. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** The most characters of one tool answer (text and structure together); a larger one is refused, never cut in the middle. */
export const MAX_RESULT_CHARS = 200_000;

export interface McpServerOptions<Context> {
  name: string;
  title: string;
  version: string;
  /** Sent at `initialize`: what this server is and how to use it, for the model. */
  instructions: string;
  /** The tools this caller may see and call (a function of the context: the sharing state decides). */
  tools: (context: Context) => ReadonlyArray<ToolDefinition<Context>>;
}

/** What a route sends back: a status, and a body (null for "accepted, nothing to say"). */
export type HandleResult =
  | { status: 200; body: JsonRpcResponse | JsonRpcResponse[] }
  | { status: 202; body: null }
  | { status: 400; body: JsonRpcResponse };

const initializeParams = z.looseObject({
  protocolVersion: z.string().max(40),
  capabilities: z.looseObject({}).optional(),
  clientInfo: z.looseObject({}).optional(),
});

const callParams = z.looseObject({
  name: z.string().min(1).max(100),
  arguments: z.looseObject({}).optional(),
});

/** What the model is told when its arguments are wrong: the field and the kind of problem, never the value. */
function describeInputProblems(error: z.ZodError): string {
  const problems = error.issues.slice(0, 5).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "the arguments";
    switch (issue.code) {
      case "invalid_type":
        return `${where}: wrong type`;
      case "too_small":
        return `${where}: too small or empty`;
      case "too_big":
        return `${where}: too large`;
      case "unrecognized_keys":
        return `${where}: has a field this tool does not take`;
      case "invalid_value":
      case "invalid_format":
        return `${where}: not an allowed value`;
      default:
        return `${where}: not valid`;
    }
  });
  return `The arguments are not valid (${problems.join("; ")}). Check the input schema of the tool.`;
}

export function toListedTool<Context>(tool: ToolDefinition<Context>): ListedTool {
  const schema = z.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
  delete schema["$schema"];
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: schema,
    annotations: tool.annotations,
  };
}

function toResult(result: ToolResult): Record<string, unknown> {
  const content = [{ type: "text", text: result.text }];
  const out: Record<string, unknown> = { content };
  if (result.data !== undefined) out["structuredContent"] = result.data;
  if (result.isError) out["isError"] = true;
  return out;
}

const errorResult = (text: string): Record<string, unknown> => toResult({ text, isError: true });

export function createMcpServer<Context>(options: McpServerOptions<Context>): {
  handle(body: unknown, context: Context, signal?: CancelSignal): Promise<HandleResult>;
} {
  async function callTool(
    params: unknown,
    context: Context,
    signal?: CancelSignal,
  ): Promise<Record<string, unknown> | { error: string }> {
    const parsed = callParams.safeParse(params);
    if (!parsed.success) return { error: "Invalid parameters." };
    const tool = options.tools(context).find((t) => t.name === parsed.data.name);
    // A tool that is not offered to this caller does not exist for them (the same answer as a name nobody made).
    if (!tool) return { error: "Unknown tool." };
    const args = tool.input.safeParse(parsed.data.arguments ?? {});
    if (!args.success) return errorResult(describeInputProblems(args.error));
    try {
      const result = await tool.run(args.data, context, signal);
      const out = toResult(result);
      if (JSON.stringify(out).length > MAX_RESULT_CHARS) {
        return errorResult(
          "The answer was too large to send. Ask for less (a smaller page, fewer columns, a LIMIT).",
        );
      }
      return out;
    } catch (error) {
      // Only a ToolError carries words meant for the model; anything else is a fixed sentence (a value could be in it).
      if (error instanceof ToolError) return errorResult(error.message);
      return errorResult("The tool failed.");
    }
  }

  async function answer(
    request: { id: RequestId; method: string; params?: unknown },
    context: Context,
    signal?: CancelSignal,
  ): Promise<JsonRpcResponse> {
    switch (request.method) {
      case "initialize": {
        const params = initializeParams.safeParse(request.params);
        if (!params.success) return failure(request.id, ERROR.invalidParams, "Invalid parameters.");
        const asked = params.data.protocolVersion;
        const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return success(request.id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, title: options.title, version: options.version },
          instructions: options.instructions,
        });
      }
      case "ping":
        return success(request.id, {});
      case "tools/list":
        return success(request.id, { tools: options.tools(context).map(toListedTool) });
      case "tools/call": {
        const result = await callTool(request.params, context, signal);
        if ("error" in result && typeof result["error"] === "string") {
          return failure(request.id, ERROR.invalidParams, result["error"]);
        }
        return success(request.id, result);
      }
      default:
        return failure(request.id, ERROR.methodNotFound, "Method not found.");
    }
  }

  return {
    async handle(body, context, signal) {
      if (Array.isArray(body)) {
        if (body.length === 0 || body.length > MAX_BATCH) {
          return { status: 400, body: failure(null, ERROR.invalidRequest, "Invalid request.") };
        }
        const answers: JsonRpcResponse[] = [];
        for (const element of body) {
          const kind = classify(element);
          if (kind.kind === "request") answers.push(await answer(kind.message, context, signal));
          else if (kind.kind === "invalid") {
            answers.push(failure(kind.id, ERROR.invalidRequest, "Invalid request."));
          }
        }
        return answers.length > 0 ? { status: 200, body: answers } : { status: 202, body: null };
      }
      const kind = classify(body);
      if (kind.kind === "request")
        return { status: 200, body: await answer(kind.message, context, signal) };
      if (kind.kind === "invalid") {
        return { status: 400, body: failure(kind.id, ERROR.invalidRequest, "Invalid request.") };
      }
      // A notification (`notifications/initialized`, `notifications/cancelled`...) or an answer of the client: accepted.
      return { status: 202, body: null };
    },
  };
}
