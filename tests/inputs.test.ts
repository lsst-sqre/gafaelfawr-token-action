import { describe, expect, it } from 'vitest';
import { InputError, parseEnvironmentUrl, parseInputs, parseScopes } from '../src/inputs.js';

function setInputs(inputs: Record<string, string>) {
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }
}

describe('parseScopes', () => {
  it('returns no scopes for an empty input', () => {
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes('  \n ')).toEqual([]);
  });

  it.each([
    ['spaces', 'write:docverse exec:linkcheck'],
    ['commas', 'write:docverse,exec:linkcheck'],
    ['commas and spaces', 'write:docverse, exec:linkcheck'],
    ['newlines', 'write:docverse\nexec:linkcheck\n'],
    ['an indented YAML block', '  write:docverse\n  exec:linkcheck\n'],
  ])('splits scopes separated by %s', (_case, raw) => {
    expect(parseScopes(raw)).toEqual(['write:docverse', 'exec:linkcheck']);
  });

  it('drops duplicates and keeps the order given', () => {
    expect(parseScopes('b a b')).toEqual(['b', 'a']);
  });
});

describe('parseEnvironmentUrl', () => {
  it.each([
    ['https://roundtable.lsst.cloud', 'https://roundtable.lsst.cloud'],
    ['https://roundtable.lsst.cloud/', 'https://roundtable.lsst.cloud'],
    ['https://roundtable.lsst.cloud/docverse/api', 'https://roundtable.lsst.cloud'],
    ['HTTPS://Roundtable.LSST.cloud', 'https://roundtable.lsst.cloud'],
    ['http://localhost:8080/auth', 'http://localhost:8080'],
  ])('reduces %s to its origin', (raw, expected) => {
    expect(parseEnvironmentUrl(raw)).toBe(expected);
  });

  it('rejects a value that is not a URL', () => {
    expect(() => parseEnvironmentUrl('roundtable.lsst.cloud')).toThrow(InputError);
    expect(() => parseEnvironmentUrl('roundtable.lsst.cloud')).toThrow(
      /must be the URL of a Phalanx environment/,
    );
  });

  it('rejects a URL that is not HTTP(S)', () => {
    expect(() => parseEnvironmentUrl('ftp://roundtable.lsst.cloud')).toThrow(/HTTP\(S\) URL/);
  });
});

describe('parseInputs', () => {
  it('defaults to every scope and the environment URL as the audience', () => {
    setInputs({ 'base-url': 'https://roundtable.lsst.cloud/' });
    expect(parseInputs()).toEqual({
      environmentUrl: 'https://roundtable.lsst.cloud',
      scopes: [],
      audience: 'https://roundtable.lsst.cloud',
    });
  });

  it('reads the scopes and an audience override', () => {
    setInputs({
      'base-url': 'https://roundtable.lsst.cloud',
      scopes: 'write:docverse\nexec:linkcheck',
      audience: ' rubin-roundtable ',
    });
    expect(parseInputs()).toEqual({
      environmentUrl: 'https://roundtable.lsst.cloud',
      scopes: ['write:docverse', 'exec:linkcheck'],
      audience: 'rubin-roundtable',
    });
  });

  it('requires base-url', () => {
    expect(() => parseInputs()).toThrow(InputError);
    expect(() => parseInputs()).toThrow(/`base-url` is required/);
  });
});
