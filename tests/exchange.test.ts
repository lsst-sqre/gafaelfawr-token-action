import * as core from '@actions/core';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, discoverGafaelfawrApiUrl, exchangeGitHubToken } from '../src/exchange.js';

// `@actions/core` v3 ships read-only ESM exports, so `vi.spyOn(core, ...)`
// throws; mock the module and replace the functions that write to the log.
vi.mock('@actions/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actions/core')>();
  return { ...actual, setSecret: vi.fn(), info: vi.fn(), debug: vi.fn() };
});

const ENVIRONMENT = 'https://example.test';
const EXCHANGE_URL = 'https://example.test/auth/api/v1/github/token';
const DISCOVERY_URL = 'https://example.test/repertoire/discovery';

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/idtoken?v=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  GITHUB_REPOSITORY: 'lsst-sqre/sqr-062',
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
// By default the environment publishes no discovery document, so the action
// falls back to the conventional Gafaelfawr path that EXCHANGE_URL uses.
beforeEach(() => {
  server.use(http.get(DISCOVERY_URL, () => new HttpResponse(null, { status: 404 })));
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function exchange(overrides: Partial<Parameters<typeof exchangeGitHubToken>[0]> = {}) {
  return exchangeGitHubToken({
    environmentUrl: ENVIRONMENT,
    audience: ENVIRONMENT,
    scopes: ['write:docverse'],
    env: ENV,
    getIdToken: async () => 'id-token-jwt',
    ...overrides,
  });
}

function rejectWith(status: number, body: Record<string, string>) {
  server.use(http.post(EXCHANGE_URL, () => HttpResponse.json(body, { status })));
}

/** Accept the exchange and return the form the action posted. */
function captureExchange(reply: Record<string, unknown>) {
  const captured = { contentType: null as string | null, form: new URLSearchParams() };
  server.use(
    http.post(EXCHANGE_URL, async ({ request }) => {
      captured.contentType = request.headers.get('content-type');
      captured.form = new URLSearchParams(await request.text());
      return HttpResponse.json(reply);
    }),
  );
  return captured;
}

describe('discoverGafaelfawrApiUrl', () => {
  const FALLBACK = 'https://example.test/auth/api/v1';

  function discovery(gafaelfawr: unknown) {
    server.use(
      http.get(DISCOVERY_URL, () => HttpResponse.json({ services: { internal: { gafaelfawr } } })),
    );
  }

  it('uses the versioned API URL from service discovery', async () => {
    discovery({
      url: 'https://example.test/auth',
      versions: { v1: { url: 'https://example.test/gafaelfawr/api/v1/' } },
    });
    await expect(discoverGafaelfawrApiUrl(ENVIRONMENT)).resolves.toBe(
      'https://example.test/gafaelfawr/api/v1',
    );
  });

  it('derives the API URL from the service root without a versions entry', async () => {
    discovery({ url: 'https://auth.example.test/' });
    await expect(discoverGafaelfawrApiUrl(ENVIRONMENT)).resolves.toBe(
      'https://auth.example.test/api/v1',
    );
  });

  it.each([
    ['is missing', () => new HttpResponse(null, { status: 404 })],
    ['is unreachable', () => HttpResponse.error()],
    ['is not JSON', () => new HttpResponse('<html>', { status: 200 })],
    ['does not list Gafaelfawr', () => HttpResponse.json({ services: { internal: {} } })],
    [
      'lists a non-HTTP URL',
      () => HttpResponse.json({ services: { internal: { gafaelfawr: { url: 'ftp://x/auth' } } } }),
    ],
  ])('falls back to /auth when discovery %s', async (_case, resolver) => {
    server.use(http.get(DISCOVERY_URL, resolver));
    await expect(discoverGafaelfawrApiUrl(ENVIRONMENT)).resolves.toBe(FALLBACK);
  });
});

describe('exchangeGitHubToken', () => {
  it('exchanges the ID token for a masked Gafaelfawr token', async () => {
    const getIdToken = vi.fn(async () => 'id-token-jwt');
    const captured = captureExchange({
      access_token: 'gt-minted',
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'write:docverse',
    });

    await expect(exchange({ getIdToken })).resolves.toEqual({
      token: 'gt-minted',
      scopes: ['write:docverse'],
      expiresIn: 3600,
    });

    expect(getIdToken).toHaveBeenCalledWith('https://example.test');
    expect(captured.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    expect(Object.fromEntries(captured.form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'id-token-jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      scope: 'write:docverse',
    });
    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith('gt-minted');
  });

  it('requests several scopes as a space-separated list', async () => {
    const captured = captureExchange({
      access_token: 'gt-minted',
      expires_in: 3600,
      scope: 'exec:linkcheck write:docverse',
    });
    const result = await exchange({ scopes: ['write:docverse', 'exec:linkcheck'] });
    expect(captured.form.get('scope')).toBe('write:docverse exec:linkcheck');
    // The scopes reported are the ones Gafaelfawr granted, in its order.
    expect(result.scopes).toEqual(['exec:linkcheck', 'write:docverse']);
  });

  it('omits the scope parameter to receive every scope of the project', async () => {
    const captured = captureExchange({
      access_token: 'gt-minted',
      expires_in: 7200,
      scope: 'exec:linkcheck write:docverse',
    });
    const result = await exchange({ scopes: [] });
    expect(captured.form.has('scope')).toBe(false);
    expect(result).toEqual({
      token: 'gt-minted',
      scopes: ['exec:linkcheck', 'write:docverse'],
      expiresIn: 7200,
    });
  });

  it('reports no scopes for a token of a project without scopes', async () => {
    captureExchange({ access_token: 'gt-minted', expires_in: 3600, scope: '' });
    await expect(exchange({ scopes: [] })).resolves.toMatchObject({ scopes: [] });
  });

  it('tolerates a reply without the optional fields', async () => {
    captureExchange({ access_token: 'gt-minted' });
    await expect(exchange()).resolves.toEqual({
      token: 'gt-minted',
      scopes: ['write:docverse'],
      expiresIn: null,
    });
  });

  it('requests the ID token for an overridden audience', async () => {
    const getIdToken = vi.fn(async () => 'id-token-jwt');
    captureExchange({ access_token: 'gt-minted', expires_in: 3600, scope: 'write:docverse' });
    await exchange({ audience: 'rubin-example', getIdToken });
    expect(getIdToken).toHaveBeenCalledWith('rubin-example');
  });

  it('posts the exchange to the Gafaelfawr URL from service discovery', async () => {
    server.use(
      http.get(DISCOVERY_URL, () =>
        HttpResponse.json({
          services: {
            internal: {
              gafaelfawr: { versions: { v1: { url: 'https://example.test/moved/api/v1' } } },
            },
          },
        }),
      ),
      http.post('https://example.test/moved/api/v1/github/token', () =>
        HttpResponse.json({ access_token: 'gt-moved' }),
      ),
    );
    const getIdToken = vi.fn(async () => 'id-token-jwt');
    await expect(exchange({ getIdToken })).resolves.toMatchObject({ token: 'gt-moved' });
    // The audience stays the environment's base URL wherever Gafaelfawr lives.
    expect(getIdToken).toHaveBeenCalledWith('https://example.test');
  });

  it('explains the missing id-token permission', async () => {
    const getIdToken = vi.fn(async () => 'unused');
    const result = exchange({ env: { GITHUB_REPOSITORY: 'lsst-sqre/sqr-062' }, getIdToken });
    await expect(result).rejects.toBeInstanceOf(AuthError);
    await expect(result).rejects.toThrow(/`id-token: write`/);
    await expect(result).rejects.toThrow(/forks/);
    expect(getIdToken).not.toHaveBeenCalled();
  });

  it('reports a failure to obtain the ID token', async () => {
    const result = exchange({
      getIdToken: async () => {
        throw new Error('Failed to get ID Token');
      },
    });
    await expect(result).rejects.toBeInstanceOf(AuthError);
    await expect(result).rejects.toThrow(
      /audience `https:\/\/example.test`: Failed to get ID Token/,
    );
  });

  describe('when no GitHub project matches', () => {
    const description =
      'No enabled GitHub project matches repository lsst-sqre/sqr-062 (ID 1, owner ID 2),' +
      ' workflow lsst-sqre/sqr-062/.github/workflows/ci.yaml@refs/heads/main,' +
      ' ref refs/heads/main, environment (none)';

    beforeEach(() => {
      rejectWith(400, { error: 'invalid_grant', error_description: description });
    });

    it('explains that the repository is not authorized', async () => {
      const result = exchange({ scopes: ['write:docverse', 'exec:linkcheck'] });
      await expect(result).rejects.toBeInstanceOf(AuthError);
      await expect(result).rejects.toThrow(/`lsst-sqre\/sqr-062` is not authorized/);
      await expect(result).rejects.toThrow(
        /register a GitHub project for `lsst-sqre\/sqr-062` with the scopes `write:docverse`, `exec:linkcheck`,/,
      );
      // The server's account of the token's claims is passed through.
      await expect(result).rejects.toThrow(description);
    });

    it('does not name scopes when none were requested', async () => {
      const result = exchange({ scopes: [] });
      await expect(result).rejects.toThrow(
        /register a GitHub project for `lsst-sqre\/sqr-062`, or to check/,
      );
    });
  });

  it('explains a project that does not grant a requested scope', async () => {
    rejectWith(400, {
      error: 'invalid_scope',
      error_description: 'Requested scopes not allowed for this workflow: exec:admin',
    });
    const result = exchange({ scopes: ['write:docverse', 'exec:admin'] });
    await expect(result).rejects.toThrow(
      /does not grant every scope requested by the `scopes` input \(`write:docverse`, `exec:admin`\)/,
    );
    await expect(result).rejects.toThrow(/not allowed for this workflow: exec:admin/);
  });

  it('reports an ID token that fails verification', async () => {
    rejectWith(400, {
      error: 'invalid_grant',
      error_description: 'Token failed verification: Invalid audience',
    });
    const result = exchange({ audience: 'rubin-example' });
    await expect(result).rejects.toThrow(/rejected this job's GitHub OIDC ID token/);
    await expect(result).rejects.toThrow(/Invalid audience/);
    await expect(result).rejects.toThrow(/requested with audience `rubin-example`/);
    await expect(result).rejects.not.toThrow(/not authorized/);
  });

  it('explains an environment without token exchange', async () => {
    server.use(http.post(EXCHANGE_URL, () => new HttpResponse('Not Found', { status: 404 })));
    await expect(exchange()).rejects.toThrow(/token exchange is not available/);
  });

  it('marks server errors as temporary', async () => {
    rejectWith(502, {
      error: 'temporarily_unavailable',
      error_description: 'Unable to retrieve GitHub Actions signing keys, retry later',
    });
    const result = exchange();
    await expect(result).rejects.toThrow(/HTTP 502/);
    await expect(result).rejects.toThrow(/re-run the job/);
  });

  it('reports other errors with the server description', async () => {
    rejectWith(400, { error: 'invalid_request', error_description: 'Missing subject_token' });
    await expect(exchange()).rejects.toThrow(/HTTP 400 invalid_request\): Missing subject_token/);
  });

  it('reports network failures', async () => {
    server.use(http.post(EXCHANGE_URL, () => HttpResponse.error()));
    const result = exchange();
    await expect(result).rejects.toBeInstanceOf(AuthError);
    await expect(result).rejects.toThrow(/Could not reach Gafaelfawr/);
  });

  it('rejects a success response without a token', async () => {
    server.use(http.post(EXCHANGE_URL, () => HttpResponse.json({ token_type: 'Bearer' })));
    await expect(exchange()).rejects.toThrow(/without an `access_token`/);
    expect(vi.mocked(core.setSecret)).not.toHaveBeenCalled();
  });
});
