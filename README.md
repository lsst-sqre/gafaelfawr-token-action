# lsst-sqre/gafaelfawr-token-action

Obtain a Rubin Science Platform or Roundtable access token from a GitHub Actions run.
With this action, your GitHub Repo identifies itself to Gafaelfawr using the OIDC token that GitHub provides in an Actions run.
If your repository is registered with Gafaelfawr (the auth service), the action obtains a short-term access token.
This method of authentication avoids storing Gafaelfawr tokens in GitHub Actions secrets.
Note that the action always authenticates as a service; user authentication is not currently supported.

For technical details, see [SQR-120: GitHub Actions OIDC token exchange in Gafaelfawr](https://sqr-120.lsst.io).
