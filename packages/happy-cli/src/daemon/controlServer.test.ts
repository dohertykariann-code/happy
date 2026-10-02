import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createDaemonControlServer } from './controlServer';

const controlToken = 'a'.repeat(64);
let server: FastifyInstance;
let onHappySessionWebhook: ReturnType<typeof vi.fn>;

function controlRoutes(): string[] {
  const table = server.printRoutes({ method: 'POST', commonPrefix: false });
  return [...table.matchAll(/(?:├──|└──)\s+(\/[^\s]*)\s+\(POST\)/g)].map((match) => match[1]);
}

async function post(path: string, authorization?: string, body: object = {}) {
  return server.inject({
    url: path,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    payload: body,
  });
}

beforeEach(async () => {
  onHappySessionWebhook = vi.fn();
  server = createDaemonControlServer({
    controlToken,
    getChildren: () => [],
    stopSession: () => ({ success: true }),
    spawnSession: async () => ({ type: 'success', sessionId: 'spawned-session' }),
    requestShutdown: vi.fn(),
    onHappySessionWebhook,
  });
});

afterEach(async () => {
  await server.close();
});

describe('daemon control server authentication', () => {
  it('requires authentication for every registered control route', async () => {
    const routes = controlRoutes();

    expect(routes).not.toEqual([]);
    for (const route of routes) {
      const response = await post(route);
      expect(response.statusCode, route).toBe(401);
    }
  });

  it('accepts the correct token and rejects wrong or malformed credentials', async () => {
    expect((await post('/list', `Bearer ${controlToken}`)).statusCode).toBe(200);
    expect((await post('/list', `Bearer ${'b'.repeat(64)}`)).statusCode).toBe(401);
    expect((await post('/list', controlToken)).statusCode).toBe(401);
    expect((await post('/list', 'Basic credential')).statusCode).toBe(401);
  });
});

describe('/session-started metadata validation', () => {
  const validMetadata = { path: '/workspace', host: 'host', homeDir: '/home', happyHomeDir: '/home/.happy', happyLibDir: '/lib', happyToolsDir: '/tools' };

  it.each([-1, 0, 1.5])('rejects an invalid hostPid of %s', async (hostPid) => {
    const response = await post('/session-started', `Bearer ${controlToken}`, {
      sessionId: 'session-1',
      metadata: { ...validMetadata, hostPid },
    });

    expect(response.statusCode).toBe(400);
    expect(onHappySessionWebhook).not.toHaveBeenCalled();
  });

  it('accepts a positive integer hostPid and preserves unknown metadata fields', async () => {
    const response = await post('/session-started', `Bearer ${controlToken}`, {
      sessionId: 'session-1',
      metadata: { ...validMetadata, hostPid: 42, unrelatedMetadata: 'preserved' },
    });

    expect(response.statusCode).toBe(200);
    expect(onHappySessionWebhook).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ hostPid: 42, unrelatedMetadata: 'preserved' }),
      undefined,
    );
  });
});
