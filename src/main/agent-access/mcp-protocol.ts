import { z } from 'zod';
import { parsePortableJson } from '@shared/models/portable';
import type { McpTools } from './mcp-tools';

const requestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().int()]).optional(),
  method: z.string().min(1).max(128), params: z.record(z.string(), z.json()).default({}) }).strict();
type Request = z.output<typeof requestSchema>;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const modernMeta = z.object({ [META_VERSION]: z.string(), [META_CLIENT]: z.object({ name: z.string().min(1).max(128), version: z.string().min(1).max(128) }).loose(),
  [META_CAPS]: z.record(z.string(), z.json()) }).loose();
const callParams = z.object({ name: z.string().min(1).max(128), arguments: z.json().default({}) }).loose();
const legacyInit = z.object({ protocolVersion: z.string().min(1).max(64), capabilities: z.record(z.string(), z.json()),
  clientInfo: z.object({ name: z.string(), version: z.string() }).loose() }).loose();
const SUPPORTED = ['2026-07-28', '2025-06-18'];
export type ProtocolReply = { readonly status: number; readonly body: object | null; readonly initializeLegacy?: boolean; readonly markInitialized?: boolean };
function error(id: string | number | undefined, code: number, message: string, data?: object): ProtocolReply {
  return { status: code === -32601 ? 404 : 400, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } } };
}
function response(id: string | number | undefined, result: object): ProtocolReply {
  if (id === undefined) return { status: 202, body: null };
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}
function headerName(value: string | undefined): string | undefined {
  if (!value?.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  try { return Buffer.from(value.slice(9, -2), 'base64').toString('utf8'); } catch { return undefined; }
}

export async function handleMcp(body: string, headers: { readonly version?: string; readonly method?: string; readonly name?: string },
  tools: McpTools, legacyState: 'initializing' | 'ready' | null): Promise<ProtocolReply> {
  let request: Request;
  try { request = requestSchema.parse(parsePortableJson(body)); }
  catch { return error(undefined, -32600, 'Invalid request'); }
  if (request.method === 'initialize') {
    if (!legacyInit.safeParse(request.params).success || request.id === undefined) return error(request.id, -32602, 'Invalid initialize request');
    return { ...response(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'interleaf', version: '0.14.0' } }), initializeLegacy: true };
  }
  if (request.method === 'notifications/initialized' && request.id === undefined && legacyState === 'initializing') return { status: 202, body: null, markInitialized: true };
  if (request.id === undefined) return error(undefined, -32600, 'Request ID is required');
  const validated = validateRequest(request, headers, legacyState);
  if ('failure' in validated) return validated.failure;
  return dispatchRequest(request, tools, validated.modern);
}

function validateRequest(request: Request, headers: { readonly version?: string; readonly method?: string; readonly name?: string }, legacyState: 'initializing' | 'ready' | null): { failure: ProtocolReply } | { modern: boolean } {
  const meta = modernMeta.safeParse(request.params._meta);
  const modern = meta.success;
  if (!modern && legacyState !== 'ready') return { failure: error(request.id, -32600, 'Required request metadata is missing') };
  if (modern) {
    const version = meta.data[META_VERSION];
    if (headers.version !== version || headers.method !== request.method) return { failure: error(request.id, -32020, 'Header mismatch') };
    if (!SUPPORTED.slice(0, 1).includes(version)) return { failure: error(request.id, -32022, 'Unsupported protocol version', { supported: SUPPORTED, requested: version }) };
    if (request.method === 'tools/call' && headerName(headers.name) !== request.params.name) return { failure: error(request.id, -32020, 'Header mismatch') };
  } else if (headers.version !== '2025-06-18') return { failure: error(request.id, -32022, 'Unsupported protocol version', { supported: SUPPORTED, requested: headers.version ?? '' }) };
  return { modern };
}

async function dispatchRequest(request: Request, tools: McpTools, modern: boolean): Promise<ProtocolReply> {
  if (request.method === 'server/discover' && modern) return response(request.id, { resultType: 'complete', supportedVersions: SUPPORTED,
    capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'interleaf', version: '0.14.0' } } });
  if (request.method === 'ping') return response(request.id, modern ? { resultType: 'complete' } : {});
  if (request.method === 'tools/list') return response(request.id, { ...(modern ? { resultType: 'complete' } : {}), tools: tools.list() });
  if (request.method !== 'tools/call') return error(request.id, -32601, 'Method not found');
  const params = callParams.safeParse(request.params);
  if (!params.success) return error(request.id, -32602, 'Invalid tool call');
  try {
    const result = await tools.call(params.data.name, params.data.arguments);
    return response(request.id, { ...(modern ? { resultType: 'complete' } : {}), content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
  } catch {
    return response(request.id, { ...(modern ? { resultType: 'complete' } : {}), content: [{ type: 'text', text: 'Tool call failed validation or source is unavailable.' }], isError: true });
  }
}
