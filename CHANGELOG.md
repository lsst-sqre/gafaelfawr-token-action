# Change log

<!-- scriv-insert-here -->

<a id='changelog-1.0.0'></a>
## 1.0.0 (2026-11-27)

### New features

- Initial release. The action obtains a short-lived [Gafaelfawr](https://gafaelfawr.lsst.io) token for a Rubin Science Platform or Roundtable environment without a stored secret. It requests an ID token from GitHub, exchanges it at Gafaelfawr's `github/token` endpoint following [SQR-120](https://sqr-120.lsst.io), masks the minted token in the job log, and provides it as the `token` output for later steps of the job. The `scopes`, `expires-in`, and `expires-at` outputs describe the token.
- The `scopes` input requests a subset of the scopes of the repository's GitHub project in Gafaelfawr. When it is omitted, the token receives every scope of the project.
- The action locates Gafaelfawr through the environment's Repertoire service discovery document (`/repertoire/discovery` on `base-url`). If discovery is unavailable or does not list Gafaelfawr, it falls back to `/auth/api/v1`.
- Authentication failures explain what to fix. The step reports a missing `id-token: write` permission, a repository with no matching GitHub project registered in Gafaelfawr (including the repository, workflow, ref, and environment that Gafaelfawr saw in the ID token), a requested scope that the project does not grant, and an environment where the token exchange is not enabled.
