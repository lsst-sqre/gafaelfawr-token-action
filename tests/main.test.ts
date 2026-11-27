import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/main.js';

// Runs the whole action against stand-ins for GitHub and Gafaelfawr, using the
// real `@actions/core` for inputs, the ID token request, and the output file.
// Only the functions that write workflow commands to stdout or set the process
// exit code are replaced.
vi.mock('@actions/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actions/core')>();
  return {
    ...actual,
    setSecret: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
});

const DISCOVERY_URL = 'https://example.test/repertoire/discovery';
const EXCHANGE_URL = 'https://example.test/auth/api/v1/github/token';

/** Audiences GitHub was asked to mint ID tokens for. */
let audiences: (string | null)[] = [];

// Gafaelfawr and Repertoire are mocked with msw. `core.getIDToken` makes its
// request through `@actions/http-client`, which msw does not intercept, so
// GitHub's ID token endpoint is a real HTTP server on the loopback interface.
const server = setupServer();
const github = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer request-token') {
    response.writeHead(401).end();
    return;
  }
  audiences.push(new URL(request.url ?? '', 'http://localhost').searchParams.get('audience'));
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ value: 'id-token-jwt' }));
});
let workDir = '';
let outputFile = '';

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
  workDir = await mkdtemp(join(tmpdir(), 'gafaelfawr-token-action-test-'));
});
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await new Promise((resolve) => github.close(resolve));
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  outputFile = join(workDir, `output-${Math.random().toString(36).slice(2)}`);
  await writeFile(outputFile, '');
  process.env.GITHUB_OUTPUT = outputFile;
  process.env.GITHUB_REPOSITORY = 'lsst-sqre/sqr-062';
  const { port } = github.address() as AddressInfo;
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `http://127.0.0.1:${port}/idtoken?api-version=2`;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'request-token';
  process.env['INPUT_BASE-URL'] = 'https://example.test';

  audiences = [];
  server.use(
    http.get(DISCOVERY_URL, () =>
      HttpResponse.json({
        services: {
          internal: {
            gafaelfawr: { versions: { v1: { url: 'https://example.test/auth/api/v1' } } },
          },
        },
      }),
    ),
  );
});

/** Parse the `name<<delimiter` records `core.setOutput` appends to the file. */
async function readOutputs(): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  const lines = (await readFile(outputFile, 'utf8')).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(.+?)<<(.+)$/.exec(lines[i] ?? '');
    if (!match) continue;
    const [, name, delimiter] = match;
    const value: string[] = [];
    for (i++; i < lines.length && lines[i] !== delimiter; i++) value.push(lines[i] ?? '');
    outputs[name!] = value.join('\n');
  }
  return outputs;
}

describe('run', () => {
  it('outputs the token, its scopes, and its expiration', async () => {
    process.env.INPUT_SCOPES = 'write:docverse\nexec:linkcheck\n';
    let form = new URLSearchParams();
    server.use(
      http.post(EXCHANGE_URL, async ({ request }) => {
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: 'gt-minted',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'exec:linkcheck write:docverse',
        });
      }),
    );

    const before = Date.now();
    await run();
    const after = Date.now();

    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    expect(audiences).toEqual(['https://example.test']);
    expect(form.get('subject_token')).toBe('id-token-jwt');
    expect(form.get('scope')).toBe('write:docverse exec:linkcheck');

    const outputs = await readOutputs();
    expect(outputs).toMatchObject({
      token: 'gt-minted',
      scopes: 'exec:linkcheck write:docverse',
      'expires-in': '3600',
    });
    const expiresAt = Date.parse(outputs['expires-at'] ?? '');
    expect(outputs['expires-at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600_000);

    // The token is masked, and the log line about it does not contain it.
    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith('gt-minted');
    const logged = vi.mocked(core.info).mock.calls.map(([message]) => message);
    expect(logged.join('\n')).toContain('with scopes exec:linkcheck, write:docverse');
    expect(logged.join('\n')).not.toContain('gt-minted');
  });

  it('requests the ID token for the audience input', async () => {
    process.env.INPUT_AUDIENCE = 'rubin-example';
    server.use(
      http.post(EXCHANGE_URL, () =>
        HttpResponse.json({ access_token: 'gt-minted', expires_in: 3600, scope: '' }),
      ),
    );
    await run();
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    expect(audiences).toEqual(['rubin-example']);
    expect(await readOutputs()).toMatchObject({ token: 'gt-minted', scopes: '' });
  });

  it('fails the step with the diagnosis when the exchange is refused', async () => {
    server.use(
      http.post(EXCHANGE_URL, () =>
        HttpResponse.json(
          {
            error: 'invalid_grant',
            error_description: 'No enabled GitHub project matches repository lsst-sqre/sqr-062',
          },
          { status: 400 },
        ),
      ),
    );
    await run();
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('`lsst-sqre/sqr-062` is not authorized to get a Gafaelfawr token'),
    );
    expect(await readOutputs()).toEqual({});
  });

  it('fails the step without the id-token permission', async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    await run();
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('`id-token: write`'),
    );
    expect(audiences).toEqual([]);
  });

  it('fails the step on an invalid input', async () => {
    process.env['INPUT_BASE-URL'] = 'roundtable.lsst.cloud';
    await run();
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Input `base-url` must be the URL of a Phalanx environment'),
    );
    expect(audiences).toEqual([]);
  });
});
