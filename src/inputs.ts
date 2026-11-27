import * as core from '@actions/core';

export interface ActionInputs {
  /**
   * Base URL of the Phalanx environment, without a trailing slash. Repertoire
   * publishes the environment's service discovery there.
   */
  environmentUrl: string;
  /** Scopes to request; empty to receive every scope of the GitHub project. */
  scopes: string[];
  /** Audience for the GitHub ID token. */
  audience: string;
}

/**
 * Invalid action input, with a message written for the workflow author. The
 * message is the whole diagnosis; `run` reports it verbatim.
 */
export class InputError extends Error {}

/**
 * Split a `scopes` input into scopes. Spaces, commas, and newlines all
 * separate scopes so that the input can be written as a YAML block or as the
 * space-separated list that Gafaelfawr itself uses. Duplicates are dropped.
 */
export function parseScopes(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter((scope) => scope !== ''))];
}

/**
 * Reduce the `base-url` input to the environment's base URL, which is the
 * origin of the URL given: a Phalanx environment is always served from the
 * root of its hostname.
 */
export function parseEnvironmentUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError(
      `Input \`base-url\` must be the URL of a Phalanx environment, such as \`https://roundtable.lsst.cloud\` (got "${raw}").`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InputError(`Input \`base-url\` must be an HTTP(S) URL (got "${raw}").`);
  }
  return url.origin;
}

export function parseInputs(): ActionInputs {
  const baseUrl = core.getInput('base-url').trim();
  if (!baseUrl) {
    throw new InputError(
      'Input `base-url` is required. Set it to the base URL of the Phalanx environment to get a token for, such as `https://roundtable.lsst.cloud`.',
    );
  }
  const environmentUrl = parseEnvironmentUrl(baseUrl);
  const scopes = parseScopes(core.getInput('scopes'));
  const audience = core.getInput('audience').trim() || environmentUrl;
  return { environmentUrl, scopes, audience };
}
