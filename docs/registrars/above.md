# Above.com — API Research

> Researched: 2026-10-28 · Docs: https://support.above.com/portfolio-manager-manual#registrar-api
> (per-function pages under https://www.above.com/manual/api/reg/)

## Overview

Above.com Registrar exposes a single-endpoint XML API. Every call is an HTTP
GET or POST to `https://www.above.com/registrar/api/query.html` with a `query`
parameter naming the function (`manage_domains`, `register`, `renew`, …) and the
function's parameters alongside it. Every response is XML wrapped in
`<results code="N">…</results>`; `code="100"` means success and any other code
is an error carrying a `<msg>`. Responses are HTTP 200 regardless of the result
code, so success is read from the body, not the status line.

The surface covers portfolio listing, registration, renewal, transfer-in,
restore, account-to-account push, nameserver update, single DNS-record create,
privacy, client lock/unlock, EPP-code retrieval, per-TLD pricing, and
account balance / add-funds, plus account-level contact listing and creation.

> **Implementation:** this adapter is built from the documented request/response
> shapes and **unit-tested**, but **not exercised against a live account** — API
> keys are issue-on-request (see Authentication) and there is **no sandbox**, so
> every call would act on a real account and balance. `registerDomain`,
> `renewDomain`, and `transferIn` additionally spend real money. Treat the write
> paths as unverified until run against a funded account.

## Authentication

- **Issue-on-request API key.** There is no self-service key generation: you
  contact your Above.com account manager or support to be issued one, and access
  is granted only to verified customers with a stated reason. Keys can be
  disabled/rotated by support at any time.
- **Bearer token.** The key is sent in the `Authorization: Bearer <key>` HTTP
  header — it does **not** go in the query string. (The manual's legacy PHP
  examples predate this and show a bare URL; the current Authentication page
  specifies the bearer header.)
- **HTTPS only.** The API refuses plaintext connections. POST is recommended over
  GET "to hide details from third parties", but both are accepted; this client
  uses GET with the parameters in the query string and the key in the header.
- **No sandbox / test environment.** All calls hit production. `supportsSandbox`
  is `false`; requesting `environment: 'sandbox'` throws.
- **Usage limits.** No documented per-day cap, but only a single concurrent
  connection is supported, and a second concurrent `register` is rejected with
  `532 - Multiple connections to API not allowed`. Above monitors usage and may
  disable a key for "unnecessarily high usage".

## Feature Support

| Feature                                     | Support | Notes / function                                                                                                                                                                                                               |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test connection / verify credentials        | ✓       | No dedicated ping; `balance` is the cheapest authenticated read and doubles as a credential check                                                                                                                              |
| List domains                                | ✓       | `manage_domains` — paginated (`offset`/`limit`, max 1000/page), `sort_by` (`domain`/`expiry`/`created`) + `order`; rows carry dates, NS, lock, privacy, auto-renew, contact ids                                                |
| Get single domain details                   | ✓       | `manage_domains&domain=<name>` (filter by exact name)                                                                                                                                                                          |
| Check domain availability                   | ✗       | No availability endpoint. `register` returns `608 - Domain not available`, but that is not a safe pre-check. Use `pricing` for cost.                                                                                           |
| Get domain/TLD pricing                      | ✓       | `pricing` — returns every supported TLD with `register`/`renew`/`transfer`/`restore` in major USD units (`restore` may be `N/A`). No params; filter client-side.                                                               |
| Register a new domain                       | ✓       | `register&domain=<name>` (+ optional numeric `contact_id`). Uses the account/TLD default contact; no inline contacts, `years`, or NS at registration.                                                                          |
| Renew a domain                              | ✓       | `renew&domain=<name>&renew_year=<n>` (registry min/max applies, typically 1–10)                                                                                                                                                |
| Auto-renew toggle                           | ✗       | `manage_domains` exposes `autorenew` (`on`/`off`/`on_once`) **read-only**; there is no function to set it                                                                                                                      |
| Transfer domain in                          | ✓       | `transfer&domain=<name>&epp_code=<code>` — queued; renewal fee is charged                                                                                                                                                      |
| Transfer out / get auth/EPP code            | ✓       | `request_epp&domain=<name>` → `<epp_code>`. Some registries (e.g. `.BE`) only email it to the registrant (`<msg>Sent to registrant email</msg>`, no code).                                                                     |
| Update nameservers                          | ✓       | `update_dns&domain=<name>&dns=ns1,ns2[,ns3,ns4]` — 2 to 4 nameservers                                                                                                                                                          |
| Get nameservers                             | ✓       | Read from `manage_domains` (`dns1`/`dns2`; `NO` when unset) — exposes up to **two**                                                                                                                                            |
| Lock / unlock domain (client transfer lock) | ✓       | `lock` / `unlock&domain=<name>`. Registrar/registry/60-day locks can't be toggled (1203–1206); `1201`/`1202` ("already …") treated as idempotent success.                                                                      |
| Get/set WHOIS privacy                       | ✓/✗     | **Set** via `privacy&domain=<name>&set_privacy=on\|off`. **Read** only (per-domain `privacy` on `manage_domains`); no standalone privacy-read.                                                                                 |
| Read contacts                               | ~       | No per-domain contact-read. A domain row carries contact _identifiers_; `manage_contacts` lists account contacts (by numeric id) with `contact_identifier`/`contact_alias`. The adapter resolves by scanning + matching those. |
| Update contact info                         | ✗       | No endpoint to reassign an existing domain's contacts. `add_contact` creates an account contact and `register`'s `contact_id` assigns one only at registration.                                                                |
| DNS record management                       | ✗       | `add_dns` **creates** one record (A/AAAA/CAA/CNAME/MX/NS/SRV/TXT); there is no record read, update, or delete, so the get/replace contract can't be honored.                                                                   |
| DNSSEC management                           | ✗       | No DNSSEC endpoints                                                                                                                                                                                                            |
| Email forwarding                            | ✗       | No email-forwarding endpoints                                                                                                                                                                                                  |
| Domain forwarding / URL redirect            | ✗       | No URL-forwarding endpoints                                                                                                                                                                                                    |
| Restore (redemption)                        | n/a     | `restore&domain=<name>&restore_reason=<text>` exists but has no slot in the core/extended contract — not exposed                                                                                                               |
| Account push                                | n/a     | `push&domain=<name>&toaccount=<user>&comment=<text>` moves a domain between Above accounts — out of the contract; not exposed                                                                                                  |
| Account balance / add funds                 | n/a     | `balance` (used for `testConnection`) and `add_funds&amount=<usd>` — account-level, not part of the registrar contract                                                                                                         |

## Implementation quick-reference

Base URL: `https://www.above.com/registrar/api/query.html`. Auth: `Authorization: Bearer <key>`. Every response is `<results code="N">…</results>`; `code=100` is success.

1. **Test connection** — `?query=balance` → `<results code="100"><balance>351.60</balance></results>`.
2. **List domains** — `?query=manage_domains&limit=1000&offset=0` → `<domains total="…"><r domain="…"><created/><expiry/><dns1/><dns2/><privacy/><autorenew/><status/><lock/>…</r></domains>`. Dates are UTC `YYYY-MM-DD HH:MM:SS`. Past the last page → `2001 - No domains found`.
3. **Pricing** — `?query=pricing` → `<r tld="com"><register/><renew/><transfer/><restore/></r>` for every TLD.
4. **Register** — `?query=register&domain=<name>` → returns the new domain's `manage_domains`-style row on `code=100`.
5. **Renew** — `?query=renew&domain=<name>&renew_year=<n>` → `<results code="100" />`.
6. **Transfer in** — `?query=transfer&domain=<name>&epp_code=<code>` → `<results code="100" />` (queued).
7. **Nameservers** — `?query=update_dns&domain=<name>&dns=ns1,ns2` (2–4) → `<results code="100" />`.
8. **Lock / unlock** — `?query=lock|unlock&domain=<name>` → `<results code="100" />`.
9. **Privacy** — `?query=privacy&domain=<name>&set_privacy=on|off` → `<results code="100" />`.
10. **EPP code** — `?query=request_epp&domain=<name>` → `<epp_code>…</epp_code>`.

## Error handling

Errors are returned in the body with HTTP 200 and a numeric code. The adapter maps:
`401 Invalid API key` → `AuthenticationError`; `402 account not verified` →
`AuthorizationError`; `500`/`501` system errors → `InvalidResponseError`;
`509 domain not in account`, `2001 no domains`, `3001 no contacts` →
`NotFoundError`; everything else → `RegistrarError` with the numeric code
preserved as `providerCode`/`status`. Write functions fold a non-100 code into a
failed `OperationResult` rather than throwing (except the retry-safety cases the
HTTP layer owns). Notable business codes: `508` insufficient balance, `514`
pending/locked, `532` concurrent-connection limit, `605` TLD not supported,
`704` privacy not allowed for TLD, `803` renew-year range, `901/903/904`
transfer states, `1201–1206` lock states, `1303–1307` nameserver validation.

## Auth / Access notes for implementors

- **Get a key from support** (account manager or support@above.com) — there is no
  developer portal or self-service key page. Expect verification.
- **No sandbox.** There is no safe place to exercise register/renew/transfer;
  they spend real account balance on a live account. Check `balance` first (the
  docs recommend it before any spend).
- **Single connection.** Don't run concurrent requests, and never a second
  `register` while one is in flight (`532`).
- **Contacts are account-level and awkwardly keyed** — a domain references a
  contact _identifier_, but `manage_contacts` filters only by numeric id, so a
  domain's contacts can only be resolved by listing + matching on
  `contact_identifier`/`contact_alias`. The single `name` field has no first/last
  split. `getContacts` here is best-effort and lossy; `updateContacts` is
  unavailable (no reassignment endpoint).
- **DNS is create-only** via `add_dns`; without read/delete there is no way to
  honor the replace-all `setDnsRecords` contract, so DNS records are unsupported.

## Sources

- https://support.above.com/portfolio-manager-manual#registrar-api
- https://www.above.com/manual/api/reg/api-manual-accessing-api.html
- https://www.above.com/manual/api/reg/api-manual-authentication.html
- https://www.above.com/manual/api/reg/api-manual-queries.html
- https://www.above.com/manual/api/reg/api-manual-manage-domains.html
- https://www.above.com/manual/api/reg/api-manual-pricing.html
- https://www.above.com/manual/api/reg/api-manual-error-codes.html
