# lsst-sqre/gafaelfawr-token-action

Obtain a Rubin Science Platform or Roundtable access token from a GitHub Actions run.
With this action, your GitHub Repo identifies itself to Gafaelfawr using the OIDC token that GitHub provides in an Actions run.
If your repository is registered with Gafaelfawr (the auth service), the action obtains a short-term access token.
This method of authentication avoids storing Gafaelfawr tokens in GitHub Actions secrets.
Note that the action always authenticates as a service; user authentication is not currently supported.

For technical details, see [SQR-120: GitHub Actions OIDC token exchange in Gafaelfawr](https://sqr-120.lsst.io).

## Quick start

```yaml
jobs:
  call-service:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # lets the action authenticate to Gafaelfawr
    steps:
      - uses: actions/checkout@v7

      - name: Get a Gafaelfawr token
        id: gafaelfawr
        uses: lsst-sqre/gafaelfawr-token-action@v1
        with:
          base-url: https://roundtable.lsst.cloud
          scopes: exec:linkcheck

      - name: Call a service
        env:
          GAFAELFAWR_TOKEN: ${{ steps.gafaelfawr.outputs.token }}
        run: |
          curl -fsS -H "Authorization: Bearer $GAFAELFAWR_TOKEN" \
            https://roundtable.lsst.cloud/<service>/<route>
```

No token or secret is stored in the repository.
The repository must be registered with the environment's Gafaelfawr first (see [Requirements](#requirements)).

The token can also be passed to another action through its inputs:

```yaml
      - uses: example/some-action@v1
        with:
          token: ${{ steps.gafaelfawr.outputs.token }}
```

## Inputs

| Input      | Required | Default                | Description |
| ---------- | -------- | ---------------------- | ----------- |
| `base-url` | yes      | —                      | Base URL of the Phalanx environment to get a token for, such as `https://roundtable.lsst.cloud` or `https://data.lsst.cloud`. Only the origin is used; any path is ignored. |
| `scopes`   | no       | every scope of the project | Scopes to request for the token, separated by spaces, commas, or newlines. They must be a subset of the scopes of the repository's GitHub project in Gafaelfawr. |
| `audience` | no       | the origin of `base-url` | Audience of the GitHub OIDC ID token. Set it only if the environment's administrators configured Gafaelfawr with a non-default audience. |

Request only the scopes that the job needs, so that a token that leaks from one job cannot be used for everything the repository is allowed to do:

```yaml
      - uses: lsst-sqre/gafaelfawr-token-action@v1
        id: gafaelfawr
        with:
          base-url: https://roundtable.lsst.cloud
          scopes: |
            write:docverse
            exec:linkcheck
```

A request for a scope that the project does not grant fails the step rather than returning a token with fewer scopes.

## Outputs

| Output       | Description |
| ------------ | ----------- |
| `token`      | The Gafaelfawr token. Present it to services as a bearer token. |
| `scopes`     | Space-separated scopes the token carries, as reported by Gafaelfawr. |
| `expires-in` | Lifetime of the token in seconds, counted from when it was issued. |
| `expires-at` | Time at which the token expires, as an ISO 8601 UTC timestamp such as `2026-11-27T19:30:00.000Z`. |

The lifetime of the token is set by the GitHub project in Gafaelfawr (one hour by default) and cannot be requested by the workflow.
A job that runs longer than that can run the action again to get a new token.

**The token is available only within the job that ran the action.**
The action registers the token as a secret, so GitHub masks it in the job log and refuses to pass it between jobs as a job output.
Run the action in each job that needs a token instead; each job then needs `id-token: write`.

## How it works

On each run the action:

1. requests an [OIDC ID token](https://docs.github.com/en/actions/concepts/security/openid-connect) from GitHub with the environment's base URL (the origin of `base-url`) as its audience;
2. locates Gafaelfawr through the environment's [Repertoire](https://repertoire.lsst.io) service discovery document (`/repertoire/discovery` on the same origin), falling back to `/auth/api/v1` on that origin if discovery is unavailable or does not list Gafaelfawr;
3. exchanges the ID token at Gafaelfawr's `github/token` endpoint for a short-lived [Gafaelfawr](https://gafaelfawr.lsst.io) token;
4. masks the token in the job log and sets it as the `token` output.

The minted token belongs to the bot user of the repository's GitHub project in Gafaelfawr (by default `bot-gh-<owner>-<repo>`) and otherwise behaves like a service token.
Services that authorize individual users, rather than only checking scopes, must grant access to that bot user.

The action is a native JavaScript action that runs on the runner's Node 24, so it works on any runner operating system and needs no `curl` or `jq`.

## Requirements

- The job must grant `id-token: write`. Grant it on the job rather than the whole workflow so other jobs cannot mint tokens. Setting `permissions` drops every permission not listed, so keep `contents: read` if the job checks out the repository.
- The repository must have a **GitHub project** registered in the Gafaelfawr of the target environment, granting the scopes the workflow requests. Registration is done by the environment's administrators (or by Templatebot for repositories it creates); see [GitHub Actions token exchange](https://gafaelfawr.lsst.io/user-guide/github-actions.html) in the Gafaelfawr documentation. A project can restrict the workflow file, Git ref, and GitHub environment that may obtain a token.
- Each Phalanx environment has its own registry. A workflow that calls services in two environments runs the action twice, once for each `base-url`, and the repository must be registered in both.
- The repository must be public, because Gafaelfawr looks it up through the GitHub API without credentials.

A job that calls a reusable workflow presents that reusable workflow's path in its ID token, so a project that restricts the workflow must name the reusable workflow.

`pull_request` runs from forks never receive an ID token, so the action cannot run for them.
Skip the job for forks with a condition such as:

```yaml
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
```

## Troubleshooting

| Error from the step | Cause and fix |
| ------------------- | ------------- |
| `GitHub did not make an OIDC ID token available to this job` | The job lacks `id-token: write`, or it is a `pull_request` run from a fork. |
| `<owner>/<repo> is not authorized to get a Gafaelfawr token …` | No enabled GitHub project in Gafaelfawr matches the run: the repository is not registered in that environment, or the project's workflow, ref, or environment constraints do not match. The message includes the values Gafaelfawr saw in the ID token; send it to the environment's administrators. |
| `… does not grant every scope requested by the scopes input` | The repository is registered, but its project lacks one of the requested scopes. The message names the refused scopes. Request fewer scopes or ask the administrators to add them. |
| `… rejected this job's GitHub OIDC ID token` | Gafaelfawr could not verify the ID token, most often because the environment expects a different audience. Set the `audience` input to the value the administrators configured. |
| `GitHub Actions token exchange is not available …` | `base-url` points at an environment whose Gafaelfawr does not have the token exchange enabled. |
| `Gafaelfawr … could not complete the token exchange (HTTP 5xx)` | Gafaelfawr or GitHub's signing-key endpoint was temporarily unavailable. Re-run the job. |

## Development

```bash
pnpm install
pnpm test             # vitest
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm build            # bundle to dist/ via esbuild (scripts/build.mjs)
```

The repository commits the bundled `dist/`, because GitHub runs the action straight from the repository. CI rebuilds it and runs `git diff --exit-code` to fail PRs that haven't been updated.

CI also runs an end-to-end smoke test (`token-smoke-test` in `ci.yml`): it executes the action from the checkout's committed `dist/` against roundtable-dev's Gafaelfawr, then presents the token to Gafaelfawr's `token-info` route to check that it authenticates as this repository's bot user with the scopes and expiration the action reported. It depends on a GitHub project for `lsst-sqre/gafaelfawr-token-action` registered in roundtable-dev's Gafaelfawr, but not on which scopes that project grants. Fork PRs skip the job because they never receive an ID token.

### Releasing

Changelog fragments accumulate in `changelog.d/` as work merges, and are collected into `CHANGELOG.md` with [scriv](https://scriv.readthedocs.io) as a prerequisite of each release. The scriv configuration lives in `changelog.d/scriv.ini`.

1. Each PR adds a `changelog.d/<date>_<topic>.md` fragment summarizing its change (`uvx scriv create` scaffolds one from the template).
2. When ready to release, on a branch run:

   ```sh
   uvx scriv collect --version X.Y.Z
   ```

   This moves the fragments into a new `## X.Y.Z (date)` section at the top of `CHANGELOG.md` and deletes them. Review and edit the section as needed, then commit and merge to `main`.
3. Tag `vX.Y.Z` on `main` and push the tag. The `Release` workflow:
   - rebuilds and verifies that `dist/` matches `src/`;
   - verifies that no uncollected fragments remain in `changelog.d/` and that `CHANGELOG.md` has a non-empty `## X.Y.Z` section, failing the release otherwise;
   - updates the floating `vX` tag via `nowactions/update-majorver`;
   - creates a GitHub Release using that section as the notes.
