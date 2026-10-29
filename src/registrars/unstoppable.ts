import type {
  ConfigField,
  ConnectionResult,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
  DomainForward,
  ListDomainsOptions,
  OperationResult,
  RegisterDomainInput,
  RegistrarCredentials,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from '../types';
import { asRead, createDomain, filterDomains, normalizeDomain, settableForwards } from '../utils';
import { NotFoundError, NotImplementedError, toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';

// Unstoppable Domains "User API": a flat set of JSON POST actions at
// /mcp/v1/actions/ud_<action>, each taking and returning JSON. Reads and writes
// are all POST, so intent is carried by the feature, not the method.

// one domain from ud_portfolio_list
interface UdPortfolioDomain {
  name?: string;
  extension?: string;
  purchasedAt?: string | null;
  expiresAt?: string | null; // ICANN (dns) domains only; null for web3 NFTs
  transferStatus?: string; // "none" | "pending"
  autoRenewal?: { status?: string; expiresAt?: string | null } | null;
}

interface UdPagination {
  hasMore?: boolean;
  nextOffset?: number | null;
  nextCursor?: string | null;
}

interface UdPortfolioResponse {
  domains?: UdPortfolioDomain[];
  pagination?: UdPagination;
}

// one result from ud_domains_search
interface UdSearchResult {
  name?: string;
  extension?: string;
  available?: boolean;
  marketplace?: { status?: string; source?: string };
  pricing?: { amount?: number; currency?: string; formatted?: string }; // amount is in CENTS
}
interface UdSearchResponse {
  results?: UdSearchResult[];
}

// one record from ud_dns_records_list (values is an array; one DNS record can
// carry several values)
interface UdDnsRecord {
  id?: string | null;
  type?: string;
  subName?: string | null; // null/"" at the apex
  values?: string[];
  ttl?: number;
  readonly?: boolean;
}
interface UdDnsRecordsResponse {
  records?: UdDnsRecord[];
  pagination?: UdPagination;
}

interface UdNameserversResponse {
  nameservers?: string[];
  isUsingDefaultNameservers?: boolean;
}

// one hosting/forwarding config from ud_dns_hosting_list
interface UdHostingConfig {
  type?: string; // REDIRECT_301 | REDIRECT_302 | LISTING_PAGE | ...
  subName?: string | null;
  targetUrl?: string | null;
}
interface UdHostingResponse {
  configs?: UdHostingConfig[];
}

// the common write envelope: a per-domain results array plus counts
interface UdWriteResponse {
  results?: { domain?: string; success?: boolean; error?: string }[];
  successCount?: number;
  failureCount?: number;
}

const DNS_HOSTING_REDIRECTS = new Set(['REDIRECT_301', 'REDIRECT_302']);

/**
 * Unstoppable Domains Registrar (User API)
 * API docs: https://docs.unstoppabledomains.com/apis/user-api/overview
 * OpenAPI: https://api.unstoppabledomains.com/mcp/v1/openapi.json
 *
 * Credentials: an API key (format `ud_mcp_…`) from Account Settings → Advanced →
 * MCP API Key. Sent as `Authorization: Bearer <key>`.
 *
 * Note: Unstoppable sells both ICANN ("dns") domains — which have real
 * expiry/renewal/DNS — and web3 NFT domains, which don't expire and have no
 * registrar-style lock/privacy/transfer. Every call is a JSON POST to
 * `/mcp/v1/actions/ud_<action>`; success/failure uses HTTP status codes, and
 * write actions return a per-domain `results` array. There is no sandbox.
 *
 * Scope (read + manage): portfolio list/get, availability + pricing, DNS records,
 * nameservers, auto-renew, and domain (URL) forwarding are implemented.
 * Registration and renewal go through a multi-step cart→checkout flow that spends
 * real money and isn't wired here yet (NotImplementedError). Transfer-in, the
 * transfer lock, WHOIS privacy, per-domain contacts and auth-code retrieval have
 * no equivalent in Unstoppable's model and also throw NotImplementedError.
 */
export class UnstoppableRegistrar extends BaseRegistrar {
  readonly name = 'unstoppable';

  static readonly displayName = 'Unstoppable Domains';
  static readonly website = 'unstoppabledomains.com';
  static readonly helpText =
    'Generate an API key in your Unstoppable Domains account under Account Settings → ' +
    'Advanced → MCP API Key (it looks like `ud_mcp_…`). It is sent as a Bearer token. ' +
    'There is no sandbox, so every change acts on your live account. Registration, ' +
    'renewal, transfer-in, transfer lock, WHOIS privacy and per-domain contacts ' +
    'aren’t available through this adapter (Unstoppable has no API for them, or they ' +
    'run through a cart/checkout flow not wired here).';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  // Production only — Unstoppable documents no sandbox/test environment.
  static readonly supportsSandbox = false;
  // Beyond core: URL (domain) forwarding via the DNS hosting redirect configs.
  // No DNSSEC enable, email forwarding, or auth-code retrieval.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetDomainForwarding,
    Feature.SetDomainForwarding,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Unstoppable Domains', options?.environment, {
          production: 'https://api.unstoppabledomains.com',
        }),
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
      },
      options
    );
  }

  // POST an action with a JSON body; `opts` carries timeout/signal and the
  // read/write intent the retry layer needs.
  private call<T>(
    action: string,
    body: Record<string, unknown> = {},
    opts?: RequestOptions
  ): Promise<T> {
    return this.http.request<T>({
      method: 'POST',
      path: `/mcp/v1/actions/${action}`,
      body,
      ...opts,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      // the lightest authenticated read that validates the key
      await this.call<UdPortfolioResponse>('ud_portfolio_list', { limit: 1 }, opts);
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Lists the whole portfolio via ud_portfolio_list, paginating by offset at the
   * 500-per-page maximum. Covers both ICANN ("dns") and web3 domains; web3
   * domains have no `expiresAt`. Nameservers aren't in the list (see
   * getNameservers). `search` is also applied client-side.
   */
  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const limit = 500; // Unstoppable's max page size
    let offset = 0;

    for (;;) {
      const res = await this.call<UdPortfolioResponse>(
        'ud_portfolio_list',
        { limit, offset, ...(search ? { searchTerm: search } : {}) },
        reqOpts
      );
      const page = res.domains ?? [];
      for (const d of page) domains.push(this.toDomain(d));
      if (!res.pagination?.hasMore || page.length === 0) break;
      offset = res.pagination.nextOffset ?? offset + limit;
    }
    return filterDomains(domains, search);
  }

  /**
   * No per-domain "get" action, so this filters the portfolio by the exact name.
   * Throws NotFoundError when it isn't in the account.
   */
  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const target = normalizeDomain(domainName);
    const res = await this.call<UdPortfolioResponse>(
      'ud_portfolio_list',
      { searchTerm: target, limit: 50 },
      opts
    );
    const match = (res.domains ?? []).find(d => normalizeDomain(d.name ?? '') === target);
    if (!match) {
      throw new NotFoundError(`Unstoppable: domain '${domainName}' is not in this account`);
    }
    return this.toDomain(match);
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const res = await this.call<UdNameserversResponse>(
      'ud_dns_nameservers_list',
      { domain: normalizeDomain(domainName) },
      opts
    );
    return res.nameservers ?? [];
  }

  /** Sets custom (external) nameservers via ud_dns_nameservers_set_custom. */
  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call<UdWriteResponse>(
      'ud_dns_nameservers_set_custom',
      { domains: [{ name: normalizeDomain(domainName), nameservers }] },
      opts
    );
    return writeResult(res, 'Nameservers updated successfully');
  }

  /**
   * Availability + pricing via ud_domains_search. `query` takes the full names;
   * each result carries `available` and a `pricing.amount` in cents.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const res = await this.call<UdSearchResponse>(
      'ud_domains_search',
      { query: domainNames.map(normalizeDomain), limit: 100 },
      opts
    );
    return (res.results ?? []).map(r => {
      const out: DomainAvailability = {
        domainName: r.name ?? '',
        available: Boolean(r.available),
      };
      const price = centsToMajor(r.pricing?.amount);
      if (price != null) {
        out.price = price;
        out.currency = r.pricing?.currency || 'USD';
      }
      // anything the marketplace reports as listed/for-sale is aftermarket
      if (r.marketplace?.status && r.marketplace.status !== 'available') out.premium = true;
      return out;
    });
  }

  /**
   * Per-domain pricing (Unstoppable has no per-TLD price table). A full domain is
   * priced directly; a bare TLD is priced via an almost-certainly-available probe
   * label so the result is the TLD's standard registration price. Only the
   * registration price is exposed (no separate renewal/transfer in search).
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const input = tldOrDomain.trim().toLowerCase();
    const tld = tldOf(input);
    const body = input.includes('.')
      ? { query: [normalizeDomain(input)] }
      : { query: ['ud-registrar-client-probe'], tlds: [tld] };
    const res = await this.call<UdSearchResponse>('ud_domains_search', { ...body, limit: 1 }, opts);
    const result = res.results?.[0];
    const registration = centsToMajor(result?.pricing?.amount);
    if (registration == null) {
      throw new NotFoundError(`Unstoppable: no pricing found for '${tldOrDomain}'`);
    }
    return { tld, currency: result?.pricing?.currency || 'USD', registration };
  }

  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call<UdWriteResponse>(
      'ud_domain_auto_renewal_update',
      { action: enabled ? 'enable' : 'disable', domains: [{ name: normalizeDomain(domainName) }] },
      opts
    );
    return writeResult(res, `Auto-renew ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Reads DNS records via ud_dns_records_list (paginated by cursor). Each
   * Unstoppable record can hold several values; this expands them into one
   * DnsRecord per value. For MX records an embedded "<priority> <host>" value is
   * split out into `priority`.
   */
  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const domain = normalizeDomain(domainName);
    const out: DnsRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await this.call<UdDnsRecordsResponse>(
        'ud_dns_records_list',
        { domain, ...(cursor ? { cursor } : {}) },
        opts
      );
      for (const rec of res.records ?? []) {
        const type = (rec.type ?? '').toUpperCase();
        const name = rec.subName && rec.subName.length ? rec.subName : '@';
        for (const raw of rec.values ?? []) {
          const record: DnsRecord = { type, name, value: raw };
          if (typeof rec.ttl === 'number') record.ttl = rec.ttl;
          if (type === 'MX') {
            const m = /^(\d+)\s+(.+)$/.exec(raw);
            if (m) {
              record.priority = Number(m[1]);
              record.value = m[2];
            }
          }
          out.push(record);
        }
      }
      cursor = res.pagination?.hasMore ? (res.pagination.nextCursor ?? undefined) : undefined;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * Replaces the record set. Unstoppable has no atomic "set all", so this clears
   * the user-created records (ud_dns_records_remove_all, which leaves the
   * provider's read-only records) and re-adds the desired set, grouping records
   * that share a type + host into one multi-value record. An empty list just
   * clears. The delegation nameservers aren't part of this (see updateNameservers).
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const domain = normalizeDomain(domainName);
    try {
      const clear = await this.call<UdWriteResponse>(
        'ud_dns_records_remove_all',
        { domains: [{ name: domain }], confirmDeleteAll: true },
        opts
      );
      const cleared = writeResult(clear, '');
      if (!cleared.success) return cleared;

      if (records.length === 0) {
        return { success: true, message: 'DNS records cleared' };
      }

      // group desired records by type + host into one UD record with many values
      const grouped = new Map<
        string,
        { type: string; subName: string; values: string[]; ttl?: number }
      >();
      for (const r of records) {
        const type = r.type.toUpperCase();
        const subName = r.name === '@' || !r.name ? '' : r.name;
        const value = type === 'MX' && r.priority != null ? `${r.priority} ${r.value}` : r.value;
        const key = `${type}\u0000${subName}`;
        const existing = grouped.get(key);
        if (existing) existing.values.push(value);
        else grouped.set(key, { type, subName, values: [value], ttl: r.ttl });
      }

      const add = await this.call<UdWriteResponse>(
        'ud_dns_record_add',
        {
          records: [...grouped.values()].map(g => ({
            domain,
            type: g.type,
            subName: g.subName,
            values: g.values,
            ...(g.ttl != null ? { ttl: g.ttl } : {}),
          })),
          upsertMode: 'append',
        },
        opts
      );
      return writeResult(add, 'DNS records updated successfully');
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  // --- extended: URL/domain forwarding via the DNS hosting redirect configs ----

  /**
   * Reads the 301/302 redirect ("hosting") configs. Non-redirect hosting types
   * (listing page, reverse proxy, UD profile, …) aren't forwarding and are skipped.
   */
  override async getDomainForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<DomainForward[]> {
    const res = await this.call<UdHostingResponse>(
      'ud_dns_hosting_list',
      { domain: normalizeDomain(domainName) },
      opts
    );
    const out: DomainForward[] = [];
    for (const c of res.configs ?? []) {
      if (!c.type || !DNS_HOSTING_REDIRECTS.has(c.type) || !c.targetUrl) continue;
      out.push({
        host: c.subName && c.subName.length ? c.subName : '@',
        url: c.targetUrl,
        type: c.type === 'REDIRECT_301' ? 'permanent' : 'temporary',
      });
    }
    return out;
  }

  /**
   * Replaces URL forwarding (full replace; empty clears). Removes the existing
   * redirect configs, then adds the desired ones (permanent → REDIRECT_301,
   * temporary → REDIRECT_302). Masked forwarding is rejected up front.
   */
  override async setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const domain = normalizeDomain(domainName);
    const desired = settableForwards(forwards); // reject masked before any write
    try {
      const current = await this.getDomainForwarding(domain, asRead(opts));
      for (const existing of current) {
        const subName = existing.host === '@' ? '' : existing.host;
        const rm = await this.call<UdWriteResponse>(
          'ud_dns_hosting_remove',
          { domains: [{ name: domain, subName }] },
          opts
        );
        const removed = writeResult(rm, '');
        if (!removed.success) return removed;
      }
      for (const f of desired) {
        const add = await this.call<UdWriteResponse>(
          'ud_dns_hosting_add',
          {
            domains: [
              {
                name: domain,
                type: f.type === 'permanent' ? 'REDIRECT_301' : 'REDIRECT_302',
                targetUrl: f.url,
                ...(f.host && f.host !== '@' ? { subName: f.host } : {}),
              },
            ],
          },
          opts
        );
        const added = writeResult(add, '');
        if (!added.success) return added;
      }
      return { success: true, message: 'Domain forwarding updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  // --- operations with no Unstoppable Domains equivalent (or out of scope) -----

  override registerDomain(
    _domainName: string,
    _input: RegisterDomainInput,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: registerDomain is not wired up — Unstoppable registers through a ` +
          'multi-step cart→checkout flow (ud_cart_add_domain → ud_cart_checkout) that spends ' +
          'real money; use the Unstoppable app/cart for now'
      )
    );
  }

  override renewDomain(
    _domainName: string,
    _years?: number,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: renewDomain is not wired up — Unstoppable renews through the cart→checkout ` +
          'flow (ud_cart_add_domain_renewal → ud_cart_checkout); use the Unstoppable app for now'
      )
    );
  }

  override transferIn(
    _domainName: string,
    _input: TransferDomainInput,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: transferIn is not available — Unstoppable has no inbound-transfer API`
      )
    );
  }

  override lockDomain(_domainName: string, _opts?: RequestOptions): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: lockDomain is not available — Unstoppable has no transfer-lock API`
      )
    );
  }

  override unlockDomain(_domainName: string, _opts?: RequestOptions): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: unlockDomain is not available — Unstoppable has no transfer-lock API`
      )
    );
  }

  override setPrivacy(
    _domainName: string,
    _enabled: boolean,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: setPrivacy is not available — Unstoppable exposes no WHOIS-privacy toggle`
      )
    );
  }

  override getContacts(_domainName: string, _opts?: RequestOptions): Promise<ContactSet> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: getContacts is not available — Unstoppable exposes account-level ICANN ` +
          'contacts (ud_contacts_list) but no per-domain contact assignment to read'
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
        `${this.name}: updateContacts is not available — Unstoppable has no per-domain ` +
          'contact-assignment API'
      )
    );
  }

  // map a portfolio entry to the normalized Domain
  private toDomain(d: UdPortfolioDomain): Domain {
    return createDomain({
      domainName: d.name,
      registrar: this.name,
      status: d.transferStatus === 'pending' ? 'pending transfer' : 'ok',
      createdDate: d.purchasedAt ?? null,
      expirationDate: d.expiresAt ?? null,
      renewalDate: d.expiresAt ?? null,
      autoRenew: d.autoRenewal?.status === 'active',
      locked: false, // Unstoppable has no transfer lock
      privacy: false, // not exposed
      nameservers: [], // not in the portfolio list (see getNameservers)
    });
  }
}

// Unstoppable prices are integer cents; convert to major units (or undefined).
function centsToMajor(cents: unknown): number | undefined {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return undefined;
  return Math.round(cents) / 100;
}

// reduce a bare TLD or a full domain to its TLD (everything after the first dot).
function tldOf(tldOrDomain: string): string {
  const s = tldOrDomain.trim().toLowerCase().replace(/^\./, '');
  return s.includes('.') ? s.slice(s.indexOf('.') + 1) : s;
}

// map Unstoppable's per-domain write envelope to an OperationResult.
function writeResult(res: UdWriteResponse, okMessage: string): OperationResult {
  const results = res.results ?? [];
  const failures = results.filter(r => r.success === false);
  const failed = res.failureCount ?? failures.length;
  if (failed > 0) {
    return { success: false, message: failures[0]?.error || 'Unstoppable: operation failed' };
  }
  return { success: true, message: okMessage || 'success' };
}
