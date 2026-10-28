import type {
  ConfigField,
  ConnectionResult,
  Contact,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
  ListDomainsOptions,
  OperationResult,
  RegisterDomainInput,
  RegistrarCredentials,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from '../types';
import { createDomain, filterDomains, normalizeDomain } from '../utils';
import {
  AuthenticationError,
  AuthorizationError,
  InvalidResponseError,
  NotFoundError,
  NotImplementedError,
  RegistrarError,
  toRegistrarError,
} from '../errors';
import { ensureArray, parseXml } from '../xml';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';

// Above.com wraps every response in `<results code="N">…</results>`. A code of
// 100 means success; anything else is an error whose `<msg>` carries the detail.
// All responses are HTTP 200 regardless of the code, so success is read from the
// body, not the status line.
interface AbResults {
  '@_code'?: string;
  'msg'?: unknown;
  // balance / add_funds
  'balance'?: unknown;
  // request_epp
  'epp_code'?: unknown;
  // manage_domains and register both return a `<domains>` wrapper of `<r>` rows
  'domains'?: { '@_total'?: string; 'r'?: AbDomainRow | AbDomainRow[] };
  // manage_contacts returns a `<contacts>` wrapper of `<r>` rows
  'contacts'?: { '@_total'?: string; 'r'?: AbContactRow | AbContactRow[] };
  // pricing returns `<r tld="…">` rows directly under `<results>`
  'r'?: AbPriceRow | AbPriceRow[];
}

// one `<r domain="…">` row from manage_domains / register. Dates are UTC
// "YYYY-MM-DD HH:MM:SS"; the `*_contact` fields are contact identifiers (not the
// numeric contact id). `dns1`/`dns2` are the delegation nameservers ("NO" if
// unset). Booleans arrive as on/off (privacy, autorenew) or On/off (lock).
interface AbDomainRow {
  '@_domain'?: string;
  'created'?: unknown;
  'expiry'?: unknown;
  'dns1'?: unknown;
  'dns2'?: unknown;
  'technical_contact'?: unknown;
  'admin_contact'?: unknown;
  'registrant_contact'?: unknown;
  'billing_contact'?: unknown;
  'privacy'?: unknown;
  'autorenew'?: unknown;
  'status'?: unknown;
  'lock'?: unknown;
  'lock_type'?: unknown;
}

// one `<r tld="…">` pricing row; values are strings in major USD units. `restore`
// may be "N/A" where restoration isn't offered for the TLD.
interface AbPriceRow {
  '@_tld'?: string;
  'register'?: unknown;
  'renew'?: unknown;
  'transfer'?: unknown;
  'restore'?: unknown;
}

// one `<r contact="…">` row from manage_contacts. `name` is a single field (no
// first/last split); `contact_identifier`/`contact_alias` are the forms a domain
// row references via its `*_contact` fields.
interface AbContactRow {
  '@_contact'?: string;
  'id'?: unknown;
  'contact_identifier'?: unknown;
  'contact_alias'?: unknown;
  'name'?: unknown;
  'company'?: unknown;
  'email'?: unknown;
  'phone'?: unknown;
  'address'?: unknown;
  'address2'?: unknown;
  'city'?: unknown;
  'state'?: unknown;
  'postcode'?: unknown;
  'country'?: unknown;
}

/**
 * Above.com Registrar
 * API docs: https://support.above.com/portfolio-manager-manual#registrar-api
 * (per-function pages under https://www.above.com/manual/api/reg/)
 *
 * Credentials: Above.com does not self-serve API keys — contact your account
 * manager or support to be issued one (granted only to verified customers). The
 * key is sent as an HTTP `Authorization: Bearer <key>` header.
 *
 * Note: a single query endpoint (`/registrar/api/query.html`) selects the
 * function via a `query` parameter; values go in the query string (GET or POST,
 * this client uses GET). Every response is XML wrapped in `<results code="N">`,
 * with `code="100"` for success. There is no sandbox/test environment.
 *
 * API gaps (left as NotImplementedError): there is no availability endpoint
 * (`checkAvailability`), no auto-renew setter (auto-renew is read-only on
 * manage_domains), no endpoint to reassign an existing domain's contacts
 * (`updateContacts`), and the DNS API only *creates* records (`add_dns`) with no
 * read/replace/delete — so `getDnsRecords`/`setDnsRecords` can't be fulfilled.
 * Above's other functions (restore, push, balance, add_funds, add_contact) have
 * no slot in the core/extended contract and aren't exposed here.
 */
export class AboveRegistrar extends BaseRegistrar {
  readonly name = 'above';

  static readonly displayName = 'Above.com';
  static readonly website = 'above.com';
  static readonly helpText =
    'Above.com API keys are not self-service: contact your account manager or ' +
    'support@above.com to be issued one (granted only to verified customers). The ' +
    'key is sent as an `Authorization: Bearer` token. There is no sandbox/test ' +
    'environment, so all calls act on your live account and balance.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  // No test/sandbox environment is documented — the API is production-only.
  static readonly supportsSandbox = false;
  // Beyond core: transfer auth-code retrieval (request_epp). Above has no DNSSEC,
  // email-forwarding, or URL-forwarding API, so no other extended features.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [Feature.GetAuthCode];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Above.com', options?.environment, {
          production: 'https://www.above.com/registrar/api/query.html',
        }),
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          // responses are always XML; ask for it rather than the client's JSON default
          Accept: 'application/xml, text/xml',
        },
      },
      options
    );
  }

  // Issue a function via the single query endpoint. The `query` parameter names
  // the function; `opts` is forwarded so timeout/signal and the read/write intent
  // the retry layer needs flow through. The API key travels in the Authorization
  // header (set at construction), never in the query string.
  private async call(
    fn: string,
    extra: Record<string, string | number> = {},
    opts?: RequestOptions
  ): Promise<AbResults> {
    const xml = await this.http.requestText({
      path: '', // baseUrl is itself the full endpoint
      query: { query: fn, ...extra },
      ...opts,
    });
    const results = parseXml<{ results?: AbResults }>(xml).results;
    if (!results || results['@_code'] === undefined) {
      throw new InvalidResponseError(`Above.com: unexpected response for '${fn}'`);
    }
    return results;
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      // `balance` is the cheapest authenticated read that validates the key
      const res = await this.call('balance', {}, opts);
      return ok(res)
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: detail(res) || `Above.com error ${code(res)}` };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Lists the whole account via manage_domains, paginating by offset at Above's
   * 1,000-per-page maximum. The list response is complete (nameservers, lock,
   * privacy, auto-renew, dates all present), so no per-domain follow-up is
   * needed. `search` is applied client-side — Above has no name filter beyond an
   * exact `domain` list. A "No domains found" (2001) past the last page ends
   * pagination rather than erroring.
   */
  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const limit = 1000; // Above's maximum page size
    let offset = 0;

    for (;;) {
      const res = await this.call('manage_domains', { limit, offset }, reqOpts);
      if (code(res) === 2001) break; // "No domains found" — past the last page
      if (!ok(res)) throw errorFor('manage_domains', res);
      const rows = ensureArray(res.domains?.r);
      for (const row of rows) domains.push(this.rowToDomain(row));
      if (rows.length < limit) break;
      offset += limit;
    }
    return filterDomains(domains, search);
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    return this.rowToDomain(await this.fetchDomainRow(domainName, opts));
  }

  // getNameservers re-reads manage_domains (the list/detail row carries dns1/dns2;
  // there's no separate nameserver endpoint), so listing enrichment gains nothing
  // from the fallback — skip it.
  override readonly requiresNameserversFetch = false;

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    return (await this.getDomain(domainName, opts)).nameservers;
  }

  /**
   * Per-TLD pricing via the `pricing` function, which returns every supported TLD
   * (register / renew / transfer / restore) in major USD units. A bare TLD works;
   * a full domain is reduced to its TLD. `restore` isn't part of TldPricing, and
   * an "N/A" value is omitted.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const tld = tldOf(tldOrDomain);
    const res = await this.call('pricing', {}, opts);
    if (!ok(res)) throw errorFor('pricing', res);
    const row = ensureArray(res.r).find(r => text(r['@_tld']).toLowerCase() === tld);
    if (!row) throw new NotFoundError(`Above.com: no pricing found for TLD '${tld}'`);
    return {
      tld,
      currency: 'USD',
      registration: toPrice(row.register),
      renewal: toPrice(row.renew),
      transfer: toPrice(row.transfer),
    };
  }

  /**
   * Registers a domain against the account's default contact (or the per-TLD
   * default). Above's `register` function takes only the domain (and an optional
   * numeric `contact_id`, which this interface has no slot for), so `input`'s
   * contacts, `years`, and `autoRenew` are NOT honored at registration:
   * nameservers (2–4) and privacy are applied as follow-up calls, auto-renew has
   * no setter at all. Spends real money (no sandbox); build-time untested.
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call('register', { domain: normalizeDomain(domainName) }, opts);
    if (!ok(res)) return statusResult(res);

    // the domain is registered; apply what `register` itself can't carry
    const notes: string[] = [];
    const nameservers = input.nameservers ?? [];
    if (nameservers.length >= 2) {
      const ns = await this.updateNameservers(domainName, nameservers, opts);
      if (!ns.success) notes.push(`nameservers not set: ${ns.message}`);
    } else if (nameservers.length === 1) {
      notes.push('nameservers not set: Above.com requires at least two');
    }
    if (input.privacy) {
      const pr = await this.setPrivacy(domainName, true, opts);
      if (!pr.success) notes.push(`privacy not enabled: ${pr.message}`);
    }
    if (input.autoRenew) {
      notes.push('auto-renew not set: Above.com has no auto-renew API');
    }
    const base = 'Domain registered successfully';
    return { success: true, message: notes.length ? `${base} (${notes.join('; ')})` : base };
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call(
      'renew',
      { domain: normalizeDomain(domainName), renew_year: years },
      opts
    );
    return statusResult(res);
  }

  /**
   * Transfers a domain in with its EPP/auth code. The transfer is queued (code
   * 100 = accepted); contacts come from the account default and `years`/`privacy`
   * aren't settable on the transfer call. Spends real money (no sandbox).
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call(
      'transfer',
      { domain: normalizeDomain(domainName), epp_code: input.authCode },
      opts
    );
    return statusResult(res);
  }

  /** Replaces the delegation nameservers (Above requires 2–4). */
  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2 || nameservers.length > 4) {
      throw new Error('Above.com requires between 2 and 4 nameservers');
    }
    const res = await this.call(
      'update_dns',
      { domain: normalizeDomain(domainName), dns: nameservers.join(',') },
      opts
    );
    return statusResult(res);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    // 1201 = "already locked" — treat as an idempotent success
    const res = await this.call('lock', { domain: normalizeDomain(domainName) }, opts);
    return statusResult(res, [1201]);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    // 1202 = "already unlocked" — treat as an idempotent success
    const res = await this.call('unlock', { domain: normalizeDomain(domainName) }, opts);
    return statusResult(res, [1202]);
  }

  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call(
      'privacy',
      { domain: normalizeDomain(domainName), set_privacy: enabled ? 'on' : 'off' },
      opts
    );
    return statusResult(res);
  }

  /**
   * Reads the registrant/admin/tech/billing contacts. Above exposes no per-domain
   * contact-read call: a domain row carries contact *identifiers*, and contacts
   * are listed account-wide (manage_contacts) keyed by a numeric id, so this
   * resolves the identifiers by scanning the contact list and matching on
   * `contact_identifier`/`contact_alias`. Above stores a single `name` field, so
   * it's split into first/last on the first space (lossy). Build-time untested.
   */
  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const row = await this.fetchDomainRow(domainName, opts);
    const roleFields: [keyof ContactSet, keyof AbDomainRow][] = [
      ['registrant', 'registrant_contact'],
      ['admin', 'admin_contact'],
      ['tech', 'technical_contact'],
      ['billing', 'billing_contact'],
    ];
    const wanted = new Map<keyof ContactSet, string>();
    for (const [role, field] of roleFields) {
      const id = text(row[field]);
      if (id) wanted.set(role, id);
    }
    if (wanted.size === 0) return {};

    // scan the account contact list until every wanted identifier is resolved
    const needed = new Set(wanted.values());
    const byKey = new Map<string, AbContactRow>();
    const limit = 1000;
    let offset = 0;
    while (needed.size > 0) {
      const res = await this.call('manage_contacts', { limit, offset }, opts);
      if (code(res) === 3001) break; // "No contacts found" — nothing (more) to scan
      if (!ok(res)) throw errorFor('manage_contacts', res);
      const rows = ensureArray(res.contacts?.r);
      if (rows.length === 0) break;
      for (const c of rows) {
        for (const key of [text(c.contact_identifier), text(c.contact_alias)]) {
          if (!key) continue;
          byKey.set(key, c);
          needed.delete(key);
        }
      }
      if (rows.length < limit) break;
      offset += limit;
    }

    const set: ContactSet = {};
    for (const [role, id] of wanted) {
      const contact = byKey.get(id);
      if (contact) set[role] = fromAboveContact(contact);
    }
    return set;
  }

  /**
   * Retrieves the transfer EPP/auth code via request_epp. Some registries (e.g.
   * .BE) only email the code to the registrant; there the API returns a message
   * and no code, so this throws rather than return an empty string.
   */
  override async getAuthCode(domainName: string, opts?: RequestOptions): Promise<string> {
    const res = await this.call('request_epp', { domain: normalizeDomain(domainName) }, opts);
    if (!ok(res)) throw errorFor('request_epp', res);
    const epp = text(res.epp_code);
    if (!epp) {
      throw new NotImplementedError(
        `Above.com: the registry sent ${domainName}'s EPP code to the registrant by email ` +
          `(e.g. .BE domains), so it can't be returned here${
            detail(res) ? ` (${detail(res)})` : ''
          }`
      );
    }
    return epp;
  }

  // --- core methods with no corresponding Above.com endpoint -------------

  override checkAvailability(
    _domainNames: string[],
    _opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: checkAvailability is not available — Above.com has no availability ` +
          'endpoint (use getPricing for the per-TLD price table)'
      )
    );
  }

  override setAutoRenew(
    _domainName: string,
    _enabled: boolean,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: setAutoRenew is not available — Above.com exposes auto-renew read-only ` +
          '(manage_domains) with no API to change it'
      )
    );
  }

  override updateContacts(
    _domainName: string,
    _contacts: ContactSet,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: updateContacts is not available — Above.com can add an account contact ` +
          'and assign one only at registration (contact_id); it has no endpoint to reassign an ' +
          "existing domain's contacts"
      )
    );
  }

  override getDnsRecords(_domainName: string, _opts?: RequestOptions): Promise<DnsRecord[]> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: getDnsRecords is not available — Above.com's DNS API only creates records ` +
          '(add_dns); it has no record-read endpoint'
      )
    );
  }

  override setDnsRecords(
    _domainName: string,
    _records: DnsRecord[],
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: setDnsRecords is not available — Above.com's DNS API only creates records ` +
          '(add_dns), with no read/replace/delete, so the replace-all contract cannot be honored'
      )
    );
  }

  // --- internals ---------------------------------------------------------

  // fetch the raw manage_domains row for one domain (carries the contact
  // identifiers that the normalized Domain drops).
  private async fetchDomainRow(domainName: string, opts?: RequestOptions): Promise<AbDomainRow> {
    const target = normalizeDomain(domainName);
    const res = await this.call('manage_domains', { domain: target }, opts);
    if (!ok(res)) throw errorFor('manage_domains', res);
    const rows = ensureArray(res.domains?.r);
    const match = rows.find(r => normalizeDomain(text(r['@_domain'])) === target) ?? rows[0];
    if (!match) {
      throw new NotFoundError(`Above.com: domain '${domainName}' is not in this account`);
    }
    return match;
  }

  private rowToDomain(row: AbDomainRow): Domain {
    return createDomain({
      domainName: text(row['@_domain']),
      registrar: this.name,
      status: text(row.status),
      createdDate: aboveDate(row.created),
      expirationDate: aboveDate(row.expiry),
      renewalDate: aboveDate(row.expiry),
      autoRenew: isOn(row.autorenew),
      locked: isOn(row.lock),
      privacy: isOn(row.privacy),
      // manage_domains exposes up to two delegation nameservers ("NO" when unset)
      nameservers: [text(row.dns1), text(row.dns2)].filter(h => h && h.toLowerCase() !== 'no'),
    });
  }
}

// safely stringify an unknown XML value (self-closing elements parse to {} / '').
function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// the numeric `code` attribute of a <results> envelope
function code(r: AbResults): number {
  return Number(r['@_code']);
}

// whether a response signals success (code 100)
function ok(r: AbResults): boolean {
  return code(r) === 100;
}

// the human-readable <msg> from a response, if any
function detail(r: AbResults): string {
  return text(r.msg);
}

// map a response to an OperationResult; `okCodes` are additional success codes
// (e.g. an idempotent "already locked") treated as success.
function statusResult(r: AbResults, okCodes: number[] = []): OperationResult {
  const c = code(r);
  if (c === 100 || okCodes.includes(c)) {
    return { success: true, message: detail(r) || 'success' };
  }
  return { success: false, message: detail(r) || `Above.com error ${c}` };
}

// map a non-success response to the closest typed RegistrarError, preserving the
// provider's numeric code. Above returns these in the body with HTTP 200.
function errorFor(fn: string, r: AbResults): RegistrarError {
  const c = code(r);
  const message = `Above.com ${fn}: ${detail(r) || 'request failed'} (code ${c})`;
  let err: RegistrarError;
  switch (c) {
    case 401:
      err = new AuthenticationError(message); // invalid API key
      break;
    case 402:
      err = new AuthorizationError(message); // account not verified
      break;
    case 500:
    case 501:
      err = new InvalidResponseError(message); // system unavailable / unknown
      break;
    case 509: // domain not in account
    case 2001: // no domains found
    case 3001: // no contacts found
      err = new NotFoundError(message);
      break;
    default:
      err = new RegistrarError(message);
      err.status = Number.isFinite(c) ? c : -1;
  }
  err.providerCode = String(c);
  return err;
}

// Above dates are UTC "YYYY-MM-DD HH:MM:SS"; normalize to an ISO-8601 UTC string
// so they parse as UTC (a bare space form is read as local time otherwise).
function aboveDate(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]}T${m[2]}Z` : s;
}

// Above booleans arrive as on/off (privacy, autorenew — "on_once" also counts as
// on) or On/off (lock).
function isOn(v: unknown): boolean {
  const s = text(v).toLowerCase();
  return s === 'on' || s === 'on_once' || s === 'yes' || s === '1' || s === 'true';
}

// reduce a bare TLD or a full domain to its TLD (everything after the first dot).
function tldOf(tldOrDomain: string): string {
  const s = tldOrDomain.trim().toLowerCase().replace(/^\./, '');
  return s.includes('.') ? s.slice(s.indexOf('.') + 1) : s;
}

// parse a price-ish string ("9.95", "N/A") into a positive number, or undefined
function toPrice(v: unknown): number | undefined {
  const s = text(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// map an Above.com contact row to the normalized Contact. Above stores a single
// `name`, split into first/last on the first space; the phone (national form
// "cc.number") is prefixed with "+" to match the library's "+cc.number" format.
function fromAboveContact(c: AbContactRow): Contact {
  const full = text(c.name);
  const space = full.indexOf(' ');
  const opt = (v: unknown): string | undefined => text(v) || undefined;
  const phone = text(c.phone);
  return {
    firstName: space === -1 ? full : full.slice(0, space),
    lastName: space === -1 ? '' : full.slice(space + 1),
    organization: opt(c.company),
    email: text(c.email),
    phone: phone && !phone.startsWith('+') ? `+${phone}` : phone,
    address1: text(c.address),
    address2: opt(c.address2),
    city: text(c.city),
    state: opt(c.state),
    postalCode: text(c.postcode),
    country: text(c.country),
  };
}
