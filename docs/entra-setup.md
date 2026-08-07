# Entra ID setup & acceptance checklist

Everything here is testable against the bundled mock provider first (`mock-oidc/`),
which is Entra-shaped and runs in `docker compose`. Use a real tenant for the
final acceptance pass — the mock proves our code handles a *correct* OIDC
provider; only a tenant proves it handles *Entra*.

---

## Getting a tenant to test with

You don't need your corporate tenant. An Azure account includes **Entra ID Free**,
which covers everything this platform uses: app registrations, SSO, optional
claims, and group claims. Create a throwaway tenant, register the two apps below,
and add two or three test users with different `department` values.

---

## App registrations

Two registrations: one for the **API** (the router) and one for the **dashboard**.
A third, for Open WebUI, is only needed if you use it.

### 1. API — the router

| Setting | Value |
|---|---|
| Name | `controldeck-api` |
| Application ID URI | `api://<application-id>` — this becomes `ENTRA_AUDIENCE` |
| Expose an API → scope | e.g. `access_as_user`, admin + user consent |

**Token configuration → Add optional claim → Access token**, add:

- `preferred_username` — the fallback the router uses for caller attribution
- `email`
- **`department`** — this is what becomes the caller's team

> Optional claims are the step people skip. Without them Entra issues access
> tokens with **no `name` and no `department`**. The router will still serve
> those callers (it falls back to `preferred_username`, then `oid`), but your
> audit trail shows email addresses instead of names and every request lands in
> "no team". If cost-by-team matters to you, `department` is not optional.

`department` must actually be populated on each user in the directory — an
optional claim for an empty attribute simply doesn't appear in the token.

### 2. Dashboard

| Setting | Value |
|---|---|
| Name | `controldeck-dashboard` |
| Redirect URI (Web) | `${DASHBOARD_APP_URL}/api/auth/callback` |
| Client secret | generate → `DASHBOARD_ENTRA_CLIENT_SECRET` |
| API permissions | `openid`, `profile`, `email` |

If you set `DASHBOARD_ADMIN_GROUP_ID`, also configure **Token configuration →
Add groups claim → Security groups**, emitted in the **ID token**. Without it the
`groups` claim never appears and every sign-in is refused as "not a member of the
admin group".

### 3. Open WebUI (optional)

Configure its connection with `auth_type: oauth`, and grant it the API's
`access_as_user` scope so the tokens it forwards carry **our** audience. A token
minted for Open WebUI's own resource is correctly rejected — that isn't a bug to
work around by widening `ENTRA_AUDIENCE`.

---

## Router configuration

```bash
ENTRA_JWKS_URI=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
ENTRA_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
ENTRA_AUDIENCE=api://<api-application-id>
ENTRA_TENANT_ID=<tenant-id>        # optional; pins the tid claim
TEAM_CLAIM=department              # default
```

`ENTRA_AUDIENCE` accepts a comma-separated list, which is occasionally needed
while migrating a client from the bare client id to `api://<id>`. Prefer one.

### A note on token lifetime

Access tokens live 60–90 minutes. That is configurable up to 24 hours via a
token lifetime policy — **don't**. This platform has no revocation mechanism by
design (PRD §6.1: no platform-side credentials, binary authorization), so token
expiry *is* the revocation window. A 24-hour token means an offboarded user
keeps API access for 24 hours.

Clients should refresh instead, which is invisible in practice: MSAL caches and
re-acquires automatically for scripts, and Open WebUI's OAuth flow renews from
its refresh token. Nobody types a token every hour.

**Mid-stream expiry is intentional.** The token is validated when the request
arrives. A 40-minute generation that began with a valid token runs to completion
even if the token expires en route — required by PRD §6.5, "requests making
progress must always be allowed to finish."

---

## Testing without a tenant

```bash
docker compose up -d mock-oidc     # Entra-shaped provider on :9000
```

Point the router at it:

```bash
ENTRA_JWKS_URI=http://localhost:9000/11111111-2222-3333-4444-555555555555/discovery/v2.0/keys
ENTRA_ISSUER=http://localhost:9000/11111111-2222-3333-4444-555555555555/v2.0
ENTRA_AUDIENCE=api://llm-gateway
```

Reproduce specific tenant behaviour with the control endpoint:

```bash
# Access tokens without name/department — Entra's default
curl -X POST localhost:9000/_control -d '{"omitName":true,"omitDepartment":true}'

# A user in >200 groups: Entra drops `groups` for a Graph pointer
curl -X POST localhost:9000/_control -d '{"groupOverage":true}'

# Short-lived tokens, and token-endpoint failure
curl -X POST localhost:9000/_control -d '{"lifetimeSec":30}'
curl -X POST localhost:9000/_control -d '{"failTokenExchange":true}'

curl localhost:9000/_control          # inspect current state
```

Visiting the authorize endpoint in a browser shows an account picker; scripted
tests append `&user=<upn>` to skip it.

---

## Acceptance checklist

Run against the real tenant once. Each line is a thing that has broken for
someone before.

### API

- [ ] A token acquired via client credentials is accepted
- [ ] `caller_name` in the `requests` table shows a **human name**, not an oid — if not, add the `preferred_username`/`name` optional claim
- [ ] `team` is populated — if not, `department` is missing from the token or empty in the directory
- [ ] A token minted for a *different* API is rejected with `auth_invalid`
- [ ] An expired token is rejected with `auth_invalid`
- [ ] A token from another tenant is rejected (only if `ENTRA_TENANT_ID` is set)
- [ ] A long streaming response completes even when the token expires mid-stream

### Dashboard

- [ ] Sign-in redirects to Entra and returns to the dashboard signed in
- [ ] The top bar shows the real display name and email
- [ ] With `DASHBOARD_ADMIN_GROUP_ID` set, a non-member is refused with a clear message
- [ ] A member is admitted
- [ ] Sign out clears the session and does not sign you out of other Entra apps

### Operational

- [ ] Router logs `JWKS endpoint reachable` at startup
- [ ] Router still starts when `ENTRA_JWKS_URI` is unreachable (logs an error, serves `/healthz`)
- [ ] Per-team breakdown on the Cost page shows real departments

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every caller shows as a GUID | `name`/`preferred_username` optional claims not configured |
| Everyone is in "no team" | `department` optional claim missing, or unset on users in the directory |
| All sign-ins refused as non-member | groups claim not configured on the dashboard registration |
| `auth_invalid` on a token that looks fine | audience mismatch — compare the token's `aud` against `ENTRA_AUDIENCE` |
| Auth fails only for some users | likely group overage; `department` avoids it entirely, which is why it's the default |
