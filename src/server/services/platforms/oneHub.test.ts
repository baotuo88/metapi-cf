import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { OneHubAdapter } from './oneHub.js';

describe('OneHubAdapter', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (server) {
      const s = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        s.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    return new Promise<void>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  it('falls back to /api/available_model when /v1/models fails', async () => {
    await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.url === '/api/available_model') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            'gpt-4o': { price: { input: 0.5, output: 1.5 } },
            'claude-3-opus': { price: { input: 1, output: 3 } },
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const models = await adapter.getModels(baseUrl, 'token');
    expect(models).toEqual(expect.arrayContaining(['gpt-4o', 'claude-3-opus']));
  });

  it('returns user groups from /api/user_group_map', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/user_group_map') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { default: 1.0, vip: 0.8 } }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const groups = await adapter.getUserGroups(baseUrl, 'token');
    expect(groups).toEqual(expect.arrayContaining(['default', 'vip']));
  });

  it('parses token list from {data: [...]} envelope', async () => {
    await startServer((req, res) => {
      if (req.url?.startsWith('/api/token/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { key: 'sk-hub-abc', name: 'my-token', status: 1, id: 1 },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const tokens = await adapter.getApiTokens(baseUrl, 'token');
    expect(tokens.length).toBe(1);
    expect(tokens[0].key).toBe('sk-hub-abc');
  });
});
