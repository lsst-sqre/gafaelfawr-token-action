import * as core from '@actions/core';
import { AuthError, exchangeGitHubToken } from './exchange.js';
import { InputError, parseInputs } from './inputs.js';

/**
 * Exchange the job's GitHub Actions OIDC ID token for a Gafaelfawr token and
 * publish it as the step's outputs.
 */
export async function run(): Promise<void> {
  try {
    const inputs = parseInputs();
    const issuedAt = Date.now();
    const { token, scopes, expiresIn } = await exchangeGitHubToken(inputs);

    // `exchangeGitHubToken` has already registered the token as a secret, so
    // it is masked wherever a later step prints it.
    core.setOutput('token', token);
    core.setOutput('scopes', scopes.join(' '));

    let expiry = '';
    if (expiresIn !== null) {
      const expiresAt = new Date(issuedAt + expiresIn * 1000).toISOString();
      core.setOutput('expires-in', String(expiresIn));
      core.setOutput('expires-at', expiresAt);
      expiry = `, expiring at ${expiresAt}`;
    }
    core.info(
      `Obtained a Gafaelfawr token from ${inputs.environmentUrl} via GitHub Actions OIDC ` +
        `with ${scopes.length > 0 ? `scopes ${scopes.join(', ')}` : 'no scopes'}${expiry}.`,
    );
  } catch (err) {
    if (err instanceof InputError || err instanceof AuthError) {
      core.setFailed(err.message);
      return;
    }
    core.setFailed(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}
