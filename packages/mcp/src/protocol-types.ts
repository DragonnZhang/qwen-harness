import { z } from 'zod';

/**
 * The MCP application-layer message shapes carried over JSON-RPC.
 *
 * Every schema here validates data coming FROM a server, which is untrusted (MC-03). A server may
 * send a tool whose description is an ANSI attack, or a JSON-Schema that is a megabyte of garbage;
 * these schemas keep discovery from crashing on it (a `.catch`/`.passthrough` where the field is
 * opaque) while still pinning the fields the client actually reads. The client sanitizes text
 * fields separately before any of it is displayed.
 */

/** The protocol revision this client speaks. Sent in `initialize` and checked against the server's. */
export const PROTOCOL_VERSION = '2025-06-18';

/** Older revisions we can still negotiate down to, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05'] as const;

// --- initialize ------------------------------------------------------------------------------

export const ClientCapabilitiesSchema = z.object({
  roots: z.object({ listChanged: z.boolean().optional() }).optional(),
  sampling: z.object({}).optional(),
  elicitation: z.object({}).optional(),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;

export const ServerCapabilitiesSchema = z
  .object({
    tools: z.object({ listChanged: z.boolean().optional() }).optional(),
    resources: z
      .object({ subscribe: z.boolean().optional(), listChanged: z.boolean().optional() })
      .optional(),
    prompts: z.object({ listChanged: z.boolean().optional() }).optional(),
    logging: z.object({}).optional(),
  })
  .passthrough();
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

export const ImplementationSchema = z.object({
  name: z.string(),
  version: z.string(),
});
export type Implementation = z.infer<typeof ImplementationSchema>;

export const InitializeResultSchema = z.object({
  protocolVersion: z.string(),
  capabilities: ServerCapabilitiesSchema,
  serverInfo: ImplementationSchema,
  // Untrusted server-authored guidance; sanitized before it is ever shown.
  instructions: z.string().optional(),
});
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

// --- tools -----------------------------------------------------------------------------------

/**
 * A tool's annotations as the SERVER declares them. This is a hint, not an authority: the harness
 * re-derives its own classification for policy (MC-04). We read them but never trust them to relax
 * anything.
 */
export const McpToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .partial();
export type McpToolAnnotations = z.infer<typeof McpToolAnnotationsSchema>;

// The JSON-Schema for a tool's input is opaque and potentially hostile. We keep it as an unknown
// record — the client never *executes* it, it forwards a bounded, sanitized form to the model and
// validates arguments structurally. `.passthrough()` on an object keeps unknown keys without
// letting a non-object through.
export const JsonSchemaSchema: z.ZodType<Record<string, unknown>> = z
  .object({})
  .passthrough() as unknown as z.ZodType<Record<string, unknown>>;

export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: JsonSchemaSchema.optional(),
  outputSchema: JsonSchemaSchema.optional(),
  annotations: McpToolAnnotationsSchema.optional(),
});
export type McpTool = z.infer<typeof McpToolSchema>;

export const ListToolsResultSchema = z.object({
  tools: z.array(McpToolSchema),
  nextCursor: z.string().optional(),
});
export type ListToolsResult = z.infer<typeof ListToolsResultSchema>;

/** One block of tool output. `text` is untrusted; the client sanitizes it before use. */
export const ContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal('resource'), resource: z.object({}).passthrough() }).passthrough(),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const CallToolResultSchema = z.object({
  content: z.array(ContentBlockSchema),
  /** True if the tool itself reported a failure (as opposed to a transport/protocol error). */
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});
export type CallToolResult = z.infer<typeof CallToolResultSchema>;

// --- resources -------------------------------------------------------------------------------

export const ResourceSchema = z.object({
  uri: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;

export const ListResourcesResultSchema = z.object({
  resources: z.array(ResourceSchema),
  nextCursor: z.string().optional(),
});
export type ListResourcesResult = z.infer<typeof ListResourcesResultSchema>;

export const ResourceContentsSchema = z.union([
  z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() }),
  z.object({ uri: z.string(), mimeType: z.string().optional(), blob: z.string() }),
]);
export const ReadResourceResultSchema = z.object({
  contents: z.array(ResourceContentsSchema),
});
export type ReadResourceResult = z.infer<typeof ReadResourceResultSchema>;

// --- prompts ---------------------------------------------------------------------------------

export const PromptArgumentSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

export const PromptSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  arguments: z.array(PromptArgumentSchema).optional(),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const ListPromptsResultSchema = z.object({
  prompts: z.array(PromptSchema),
  nextCursor: z.string().optional(),
});
export type ListPromptsResult = z.infer<typeof ListPromptsResultSchema>;

export const PromptMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: ContentBlockSchema,
});
export const GetPromptResultSchema = z.object({
  description: z.string().optional(),
  messages: z.array(PromptMessageSchema),
});
export type GetPromptResult = z.infer<typeof GetPromptResultSchema>;

// --- method names ----------------------------------------------------------------------------

export const MCP_METHODS = {
  initialize: 'initialize',
  initialized: 'notifications/initialized',
  ping: 'ping',
  listTools: 'tools/list',
  callTool: 'tools/call',
  listResources: 'resources/list',
  readResource: 'resources/read',
  listPrompts: 'prompts/list',
  getPrompt: 'prompts/get',
  toolsListChanged: 'notifications/tools/list_changed',
  resourcesListChanged: 'notifications/resources/list_changed',
  promptsListChanged: 'notifications/prompts/list_changed',
  // Reverse channel (server → client):
  elicitationCreate: 'elicitation/create',
  samplingCreate: 'sampling/createMessage',
  rootsList: 'roots/list',
} as const;
