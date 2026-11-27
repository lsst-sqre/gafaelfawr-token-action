import { afterEach, beforeEach } from 'vitest';

// Environment variables the action reads. Each test starts with all of them
// unset and the developer's (or CI runner's) own values are restored after.
const SNAPSHOT_KEYS = [
  'INPUT_BASE-URL',
  'INPUT_SCOPES',
  'INPUT_AUDIENCE',
  'GITHUB_ACTIONS',
  'GITHUB_REPOSITORY',
  'GITHUB_OUTPUT',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];

const snapshot = new Map<string, string | undefined>();

beforeEach(() => {
  snapshot.clear();
  for (const key of SNAPSHOT_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});
