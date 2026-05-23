import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { CliProxyApiAdapter } from './cliproxyapi.js';

describe('CliProxyApiAdapter detect', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl = '';
  let adapter: CliProxyApiAdapter;

  beforeEach(() => {
    adapter = new CliProxyApiAdapter();
  });

  afterEach(async () => {
    if (!server) return;
    const current = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => {
      current.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    await new Promise<void>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  it('detects known default cliproxy port', async () => {
    expect(await adapter.detect('http://127.0.0.1:8317')).toBe(true);
  });

  it('does not treat generic 401 response as cliproxy', async () => {
    await startServer((req, res) => {
      if (req.url === '/v0/management/openai-compatibility') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(404).end();
    });

    expect(await adapter.detect(baseUrl)).toBe(false);
  });

  it('detects cliproxy management endpoint by X-CPA headers', async () => {
    await startServer((req, res) => {
      if (req.url === '/v0/management/openai-compatibility') {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'X-CPA-VERSION': 'v0.0.0-test',
        });
        res.end(JSON.stringify({ error: 'missing management key' }));
        return;
      }
      res.writeHead(404).end();
    });

    expect(await adapter.detect(baseUrl)).toBe(true);
  });

  it('detects open management endpoint by response payload key', async () => {
    await startServer((req, res) => {
      if (req.url === '/v0/management/openai-compatibility') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 'openai-compatibility': [] }));
        return;
      }
      res.writeHead(404).end();
    });

    expect(await adapter.detect(baseUrl)).toBe(true);
  });
});
