import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpTools } from './mcp-tools';
import { handleMcp } from './mcp-protocol';
import { AgentAccessLifetime } from './lifetime';

const MAX_BODY = 65_536;
const MAX_SESSIONS = 64;
const SESSION_TTL = 30 * 60_000;

/** Loopback-only, authenticated, no CORS. Token lives only in main memory. */
export class McpServer {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly sessions = new Map<string, { expiry: number; state: 'initializing' | 'ready' }>();
  private readonly server: Server;
  private port = 0;
  private starting: Promise<void> | null = null;
  constructor(private readonly tools: McpTools, private readonly lifetime = new AgentAccessLifetime()) {
    this.server = createServer((request, response) => { this.handle(request, response); });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.server.maxConnections = 32;
    this.server.on('error', () => { this.port = 0; });
  }

  start(): Promise<void> {
    if (!this.lifetime.isOpen()) return Promise.reject(new Error('MCP server is closed.'));
    const starting = new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string') { reject(new Error('MCP server has no TCP address.')); return; }
        if (this.lifetime.isOpen()) this.port = address.port;
        resolve();
      });
    });
    this.starting = starting;
    return starting;
  }

  /** Only call from a deliberate main-owned user action; never expose to renderer. */
  connection(): { readonly url: string; readonly token: string } {
    if (this.port === 0) throw new Error('MCP server is not running.');
    return { url: `http://127.0.0.1:${String(this.port)}/mcp`, token: this.token };
  }

  closeAdmission(): void {
    this.lifetime.closeAdmission();
    this.server.closeAllConnections();
  }

  async close(): Promise<void> {
    this.closeAdmission();
    this.port = 0;
    this.sessions.clear();
    if (this.starting) await this.starting.catch(() => undefined);
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    return new Promise<void>((resolve, reject) => { this.server.close((error) => { if (error) reject(error); else resolve(); }); });
  }

  private authenticated(value: string | undefined): boolean {
    const received = Buffer.from(value ?? '', 'utf8');
    const expected = Buffer.from(`Bearer ${this.token}`, 'utf8');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const release = this.lifetime.enter();
    if (!release) { response.writeHead(503).end(); return; }
    response.once('close', release);
    if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${String(this.port)}` ||
        !this.authenticated(request.headers.authorization)) { response.writeHead(403).end(); return; }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json') ||
        !request.headers.accept?.includes('application/json') || !request.headers.accept.includes('text/event-stream')) {
      response.writeHead(400).end(); return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { response.writeHead(413).end(); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (response.writableEnded || request.destroyed || !this.lifetime.isOpen()) return;
      void this.process(request, response, Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', () => { if (!response.writableEnded) response.writeHead(400).end(); });
  }

  private async process(request: IncomingMessage, response: ServerResponse, body: string): Promise<void> {
    const release = this.lifetime.enter();
    if (!release) return;
    try {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.expiry <= now) this.sessions.delete(id);
    const session = request.headers['mcp-session-id'];
    const sessionId = typeof session === 'string' ? session : '';
    const reply = await handleMcp(body, { ...(typeof request.headers['mcp-protocol-version'] === 'string' ? { version: request.headers['mcp-protocol-version'] } : {}),
      ...(typeof request.headers['mcp-method'] === 'string' ? { method: request.headers['mcp-method'] } : {}),
      ...(typeof request.headers['mcp-name'] === 'string' ? { name: request.headers['mcp-name'] } : {}) }, this.tools, this.sessions.get(sessionId)?.state ?? null);
    if (!this.lifetime.isOpen() || response.destroyed) return;
    const activeSession = this.sessions.get(sessionId);
    if (reply.markInitialized && activeSession) activeSession.state = 'ready';
    if (reply.initializeLegacy) {
      if (this.sessions.size >= MAX_SESSIONS) { response.writeHead(503).end(); return; }
      const id = randomBytes(24).toString('base64url');
      this.sessions.set(id, { expiry: now + SESSION_TTL, state: 'initializing' });
      response.setHeader('Mcp-Session-Id', id);
    }
    response.setHeader('Cache-Control', 'no-store');
    if (reply.body === null) { response.writeHead(reply.status).end(); return; }
    response.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
    } catch {
      if (this.lifetime.isOpen() && !response.destroyed && !response.writableEnded) response.writeHead(500).end();
    } finally { release(); }
  }
}
