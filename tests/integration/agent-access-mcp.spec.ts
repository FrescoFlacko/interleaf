import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ReadingPositionRepository } from '@main/db/repositories/reading-position-repository';
import { SearchRepository } from '@main/db/repositories/search-repository';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { ProposalRepository } from '@main/agent-access/proposal-repository';
import { LibraryReader } from '@main/agent-access/library-reader';
import { McpTools } from '@main/agent-access/mcp-tools';
import { McpServer } from '@main/agent-access/mcp-server';

const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'integration-client', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {} };

describe('MCP HTTP boundary', () => {
  it('authenticates real HTTP requests and serves modern discovery and indexed reads', async () => {
    const db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    new DocumentRepository(db).insert({ id: 'doc', title: 'Fixture', author: null, format: 'pdf', filePath: '/fixture.pdf',
      storageMode: 'link', fileSize: 1, fileMtimeMs: 1, fileHash: 'hash', pageCount: 1 });
    const search = new SearchRepository(db);
    const generation = search.begin('doc', 'hash');
    search.append('doc', 'hash', generation.generationId, [{ ordinal: 0, text: 'The useful source.',
      location: { format: 'pdf', pageIndex: 0 }, heading: null, pageLabel: null }]);
    search.complete('doc', 'hash', generation.generationId);
    const reader = new LibraryReader(db, search, new AnnotationRepository(db), new ReadingPositionRepository(db));
    const server = new McpServer(new McpTools(reader, new ProposalRepository(db, { annotation: () => 'unused' }), () => false));
    await server.start();
    const { url, token } = server.connection();
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } });
    try {
      expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body })).status).toBe(403);
      expect((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body })).status).toBe(403);
      const discovery = await fetch(url, { method: 'POST', headers, body });
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({ result: { supportedVersions: ['2026-07-28', '2025-06-18'] } });
      const searchBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { _meta: meta, name: 'search_library', arguments: { query: 'useful' } } });
      const searchResponse = await fetch(url, { method: 'POST', headers: { ...headers, 'mcp-method': 'tools/call', 'mcp-name': 'search_library' }, body: searchBody });
      expect(searchResponse.status).toBe(200);
      const result = await searchResponse.json();
      expect(JSON.stringify(result)).toContain('interleaf://doc/doc#');
      expect((await fetch(url, { method: 'POST', headers: { ...headers, 'mcp-method': 'wrong' }, body })).status).toBe(400);
      const legacyBody = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } });
      const legacy = await fetch(url, { method: 'POST', headers, body: legacyBody });
      expect(legacy.status).toBe(200);
      const session = legacy.headers.get('mcp-session-id');
      expect(session).toBeTruthy();
      const legacyHeaders = { ...headers, 'mcp-protocol-version': '2025-06-18', 'mcp-session-id': session ?? '' };
      const listBody = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
      expect((await fetch(url, { method: 'POST', headers: legacyHeaders, body: listBody })).status).toBe(400);
      const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      expect((await fetch(url, { method: 'POST', headers: legacyHeaders, body: initialized })).status).toBe(202);
      const list = await fetch(url, { method: 'POST', headers: legacyHeaders, body: listBody });
      expect(list.status).toBe(200);
      expect(JSON.stringify(await list.json())).not.toContain('submit_proposal');
    } finally { await server.close(); db.close(); }
  });
});
