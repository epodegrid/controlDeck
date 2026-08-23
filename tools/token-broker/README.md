# controlDeck token broker

A local process that holds your Entra **refresh** token and attaches a fresh
access token to every request, so tools that only accept a static API key stop
expiring an hour into a session.

```bash
export CONTROLDECK_TENANT_ID=<tenant guid>
export CONTROLDECK_CLIENT_ID=<public client app id>
export CONTROLDECK_GATEWAY=https://controldeck.internal.example

node controldeck-token-broker.mjs login   # once, interactive
node controldeck-token-broker.mjs serve   # then leave running
```

Point your tool at `http://127.0.0.1:8787/v1` with any placeholder key.

Why a proxy rather than a rotating key file: opencode resolves its `apiKey`
once at start-up and reuses it for the whole session, so rewriting a file
underneath it changes nothing. Measured, not assumed — see
[docs/client-authentication.md](../../docs/client-authentication.md).

No dependencies; Node 20+.

| Variable | Default | Meaning |
|---|---|---|
| `CONTROLDECK_TENANT_ID` | — | Entra tenant GUID |
| `CONTROLDECK_CLIENT_ID` | — | app id of the public client registration |
| `CONTROLDECK_GATEWAY` | — | base URL of the gateway, no trailing `/v1` |
| `CONTROLDECK_SCOPE` | `api://llm-gateway/.default offline_access` | must include `offline_access` |
| `CONTROLDECK_BROKER_PORT` | `8787` | local listen port |
| `CONTROLDECK_STATE` | `~/.controldeck/token.json` | where the refresh token is cached, mode `0600` |
| `CONTROLDECK_AUTHORITY` | `https://login.microsoftonline.com/<tenant>` | override for testing against a stub |
