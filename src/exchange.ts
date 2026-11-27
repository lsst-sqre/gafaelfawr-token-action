import * as core from '@actions/core';

const DISCOVERY_PATH = '/repertoire/discovery';
/** Gafaelfawr's v1 API path, used when service discovery has no answer. */
const DEFAULT_GAFAELFAWR_API_PATH = '/auth/api/v1';
/** Token exchange route, relative to Gafaelfawr's v1 API. */
const TOKEN_EXCHANGE_ROUTE = '/github/token';
const DISCOVERY_TIMEOUT_MS = 10_000;
const EXCHANGE_TIMEOUT_MS = 30_000;
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';

/** Prefix of Gafaelfawr's `invalid_grant` description when no project matches. */
const NO_PROJECT_PREFIX = 'No enabled GitHub project matches';

type Fetch = typeof globalThis.fetch;

/**
 * Authentication failure with a message written for the workflow author. The
 * message is the whole diagnosis; `run` reports it verbatim.
 */
export class AuthError extends Error {}

export interface TokenExchangeOptions {
  /** Base URL of the Phalanx environment, without a trailing slash. */
  environmentUrl: string;
  /** Audience to request for the GitHub ID token. */
  audience: string;
  /** Scopes to request; empty to receive every scope of the GitHub project. */
  scopes: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  /** Obtains the GitHub Actions ID token; injectable for tests. */
  getIdToken?: (audience: string) => Promise<string>;
}

/** A Gafaelfawr token minted by the exchange. */
export interface GafaelfawrToken {
  token: string;
  /** Scopes the token carries, as reported by Gafaelfawr. */
  scopes: string[];
  /** Lifetime in seconds from the time of issue, if Gafaelfawr reported it. */
  expiresIn: number | null;
}

/**
 * Locate Gafaelfawr's v1 API through the environment's Repertoire service
 * discovery document, so the action follows Gafaelfawr if its API ever moves.
 * Discovery is best-effort: if the document cannot be fetched or does not
 * list Gafaelfawr, fall back to the conventional `/auth/api/v1` path on the
 * environment's base URL.
 */
export async function discoverGafaelfawrApiUrl(
  environmentUrl: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<string> {
  const fallback = `${environmentUrl}${DEFAULT_GAFAELFAWR_API_PATH}`;
  const discoveryUrl = `${environmentUrl}${DISCOVERY_PATH}`;
  let reason: string;
  try {
    const response = await fetchImpl(discoveryUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.ok) {
      const url = gafaelfawrApiUrlFrom(await response.json());
      if (url !== null) {
        core.debug(`Service discovery located the Gafaelfawr API at ${url}`);
        return url;
      }
      reason = 'it does not list a usable Gafaelfawr API URL';
    } else {
      reason = `HTTP ${response.status}`;
    }
  } catch (err) {
    reason = messageOf(err);
  }
  core.info(
    `Service discovery at ${discoveryUrl} was not usable (${reason}); assuming Gafaelfawr is at ${fallback}.`,
  );
  return fallback;
}

/**
 * Read `services.internal.gafaelfawr` from a Repertoire discovery document:
 * the versioned `versions.v1.url` when present, else the service root plus
 * `/api/v1`. Returns `null` when neither is an HTTP(S) URL.
 */
function gafaelfawrApiUrlFrom(discovery: unknown): string | null {
  const service = property(property(property(discovery, 'services'), 'internal'), 'gafaelfawr');
  const versioned = httpUrl(property(property(property(service, 'versions'), 'v1'), 'url'));
  if (versioned !== null) return versioned;
  const root = httpUrl(property(service, 'url'));
  return root !== null ? `${root}/api/v1` : null;
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A string that parses as an HTTP(S) URL, without trailing slashes. */
function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  if (!/^https?:$/.test(new URL(value).protocol)) return null;
  return value.replace(/\/+$/, '');
}

/**
 * Obtain a Gafaelfawr token by exchanging the job's GitHub Actions OIDC ID
 * token (SQR-120). The returned token is registered as a secret so it is
 * masked in the job log.
 */
export async function exchangeGitHubToken(opts: TokenExchangeOptions): Promise<GafaelfawrToken> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const getIdToken = opts.getIdToken ?? ((audience: string) => core.getIDToken(audience));
  const { environmentUrl, audience, scopes } = opts;
  const repository = env.GITHUB_REPOSITORY || 'this repository';

  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new AuthError(
      'GitHub did not make an OIDC ID token available to this job. Add `id-token: write` to the ' +
        "job's `permissions` (alongside `contents: read`). Note that `pull_request` runs from " +
        'forks never receive an ID token, so a Gafaelfawr token cannot be obtained for fork ' +
        'pull requests.',
    );
  }

  let idToken: string;
  try {
    idToken = await getIdToken(audience);
  } catch (err) {
    throw new AuthError(
      `Could not get a GitHub OIDC ID token for audience \`${audience}\`: ${messageOf(err)}`,
    );
  }

  const exchangeUrl = `${await discoverGafaelfawrApiUrl(environmentUrl, fetchImpl)}${TOKEN_EXCHANGE_ROUTE}`;

  const form = new URLSearchParams({
    grant_type: GRANT_TYPE,
    subject_token: idToken,
    subject_token_type: ID_TOKEN_TYPE,
  });
  // Gafaelfawr grants every scope of the project when `scope` is omitted.
  if (scopes.length > 0) form.set('scope', scopes.join(' '));

  let response: Response;
  try {
    response = await fetchImpl(exchangeUrl, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AuthError(
      `Could not reach Gafaelfawr at \`${exchangeUrl}\`: ${messageOf(err)}. Check the \`base-url\` input and network connectivity.`,
    );
  }

  const rawBody = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    throw new AuthError(
      formatExchangeError({
        status: response.status,
        body,
        rawBody,
        repository,
        environmentUrl,
        audience,
        scopes,
      }),
    );
  }

  const token = property(body, 'access_token');
  if (typeof token !== 'string' || token === '') {
    throw new AuthError(
      `Gafaelfawr at \`${exchangeUrl}\` returned a successful response without an \`access_token\`.`,
    );
  }
  core.setSecret(token);

  const grantedScope = property(body, 'scope');
  const expiresIn = property(body, 'expires_in');
  return {
    token,
    // Gafaelfawr always reports the scopes; fall back to the request if not.
    scopes: typeof grantedScope === 'string' ? grantedScope.split(/\s+/).filter(Boolean) : scopes,
    expiresIn: typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : null,
  };
}

interface ExchangeFailure {
  status: number;
  body: unknown;
  rawBody: string;
  repository: string;
  environmentUrl: string;
  audience: string;
  scopes: string[];
}

/**
 * Turn a failed token exchange into a message that says what to fix. Gafaelfawr
 * replies with an OAuth 2.0 error document (`error`, `error_description`); its
 * description names the failed check and the claims of the caller's own token,
 * so it is always passed through.
 */
export function formatExchangeError(failure: ExchangeFailure): string {
  const { status, repository, environmentUrl, audience, scopes } = failure;
  const { error, description } = parseOAuthError(failure.body);
  const detail = description ?? (failure.rawBody.slice(0, 400) || '<empty body>');
  const requested = scopes.map((scope) => `\`${scope}\``).join(', ');

  if (error === 'invalid_grant' && description?.startsWith(NO_PROJECT_PREFIX)) {
    return (
      `\`${repository}\` is not authorized to get a Gafaelfawr token from \`${environmentUrl}\`: ` +
      'no enabled GitHub project registered in Gafaelfawr matches this workflow run. Either the ' +
      'repository has not been registered, or the registered project restricts the workflow, ' +
      'ref, or environment to values that this run does not match. Ask the administrators of ' +
      `\`${environmentUrl}\` to register a GitHub project for \`${repository}\`` +
      (scopes.length > 0 ? ` with the scopes ${requested}` : '') +
      ', or to check its constraints against the values below. ' +
      `Gafaelfawr said: ${detail}`
    );
  }
  if (error === 'invalid_scope') {
    return (
      `The GitHub project registered in Gafaelfawr for \`${repository}\` does not grant every ` +
      `scope requested by the \`scopes\` input (${requested || 'none'}). Request only scopes ` +
      `the project grants, or ask the administrators of \`${environmentUrl}\` to add the ` +
      `missing scopes to the project. Gafaelfawr said: ${detail}`
    );
  }
  if (error === 'invalid_grant') {
    return (
      `Gafaelfawr at \`${environmentUrl}\` rejected this job's GitHub OIDC ID token: ${detail}. ` +
      `The token was requested with audience \`${audience}\`; if this environment is ` +
      'configured with a different audience, set the `audience` input, and check that the ' +
      '`base-url` input points at the right environment.'
    );
  }
  if (status === 404) {
    return (
      `GitHub Actions token exchange is not available at \`${environmentUrl}\` (HTTP 404). ` +
      'Check that the `base-url` input points at the right environment and that its Gafaelfawr ' +
      'has the GitHub token exchange enabled.'
    );
  }
  if (status >= 500) {
    return (
      `Gafaelfawr at \`${environmentUrl}\` could not complete the token exchange (HTTP ${status}): ` +
      `${detail}. This is usually temporary; re-run the job.`
    );
  }
  return `Gafaelfawr token exchange at \`${environmentUrl}\` failed (HTTP ${status}${error ? ` ${error}` : ''}): ${detail}`;
}

function parseOAuthError(body: unknown): { error?: string; description?: string } {
  const error = property(body, 'error');
  const description = property(body, 'error_description');
  return {
    error: typeof error === 'string' ? error : undefined,
    description: typeof description === 'string' ? description : undefined,
  };
}

/**
 * Describe an error together with its `cause`. Node's fetch reports every
 * network failure as `fetch failed` and puts the real error (DNS, TLS,
 * refused connection) in the cause.
 */
function messageOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = describeCause(err.cause);
  return cause ? `${err.message}: ${cause}` : err.message;
}

/** The code and message of an error's cause; empty if there is nothing to add. */
function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return '';
  if (typeof cause !== 'object') return String(cause);
  const code = property(cause, 'code');
  const ownMessage = property(cause, 'message');
  const errors = property(cause, 'errors');
  let message = typeof ownMessage === 'string' ? ownMessage : '';
  // A refused connection to a dual-stack host is an AggregateError with an
  // empty message and one error per address tried.
  if (message === '' && Array.isArray(errors)) {
    message = [...new Set(errors.map(describeCause).filter(Boolean))].join('; ');
  }
  if (typeof code !== 'string' || code === '') return message;
  if (message === '') return code;
  return message.includes(code) ? message : `${code}: ${message}`;
}
