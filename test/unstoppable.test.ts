import { describe, it, expect } from 'vitest';
import { createRegistrar, registrars, NotFoundError, NotImplementedError } from '../src/index';
import type { RequestConfig } from '../src/http';

// Unstoppable speaks JSON over HttpClient.request. Stub it; the handler is keyed
// off the action (the last path segment) for multi-call flows.
function stubHttp(
  provider: unknown,
  handler: (action: string, req: RequestConfig) => unknown
): RequestConfig[] {
  const calls: RequestConfig[] = [];
  (provider as { http: { request: (req: RequestConfig) => Promise<unknown> } }).http.request = (
    req: RequestConfig
  ) => {
    calls.push(req);
    const action = (req.path ?? '').split('/').pop() ?? '';
    return Promise.resolve(handler(action, req));
  };
  return calls;
}

const ud = () => createRegistrar('unstoppable', { apiKey: 'ud_mcp_test' });
const OK_WRITE = { results: [{ success: true }], successCount: 1, failureCount: 0 };

describe('Unstoppable Domains provider', () => {
  it('exposes discovery metadata and the forwarding extended feature', () => {
    const U = registrars.unstoppable;
    expect(U.displayName).toBe('Unstoppable Domains');
    expect(U.website).toBe('unstoppabledomains.com');
    expect(U.supportsSandbox).toBe(false);
    expect(U.configFields.map(f => f.name)).toEqual(['apiKey']);
    expect(U.features).toContain('setDomainForwarding');
    expect(U.features).not.toContain('getAuthCode');
  });

  it('sends the key as a Bearer header and validates via portfolio_list', async () => {
    const u = ud();
    const calls = stubHttp(u, () => ({ domains: [], pagination: { hasMore: false } }));
    const res = await u.testConnection();
    expect(res.success).toBe(true);
    expect(calls[0].path).toBe('/mcp/v1/actions/ud_portfolio_list');
    expect(calls[0].method).toBe('POST');
    expect(JSON.stringify(calls[0].body)).not.toContain('ud_mcp_test'); // key is a header, not body
  });

  it('listDomains maps ICANN + web3 entries and paginates by offset', async () => {
    const u = ud();
    const page1 = {
      domains: [
        {
          name: 'example.com',
          extension: 'com',
          purchasedAt: '2023-01-01T00:00:00Z',
          expiresAt: '2027-01-01T00:00:00Z',
          transferStatus: 'none',
          autoRenewal: { status: 'active' },
        },
      ],
      pagination: { hasMore: true, nextOffset: 500 },
    };
    const page2 = {
      domains: [
        {
          name: 'vitalik.crypto',
          extension: 'crypto',
          expiresAt: null,
          transferStatus: 'none',
          autoRenewal: null,
        },
      ],
      pagination: { hasMore: false, nextOffset: null },
    };
    const calls = stubHttp(u, (_a, req) =>
      (req.body as { offset?: number }).offset ? page2 : page1
    );
    const all = await u.listDomains();
    expect(calls.map(c => (c.body as { offset?: number }).offset)).toEqual([0, 500]);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      domainName: 'example.com',
      registrar: 'unstoppable',
      autoRenew: true,
      locked: false,
    });
    expect(all[0].expirationDate?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    // web3 NFT: no expiry, auto-renew off
    expect(all[1]).toMatchObject({ domainName: 'vitalik.crypto', autoRenew: false });
    expect(all[1].expirationDate).toBeNull();
  });

  it('getDomain filters the portfolio and throws NotFound when absent', async () => {
    const u = ud();
    stubHttp(u, () => ({
      domains: [{ name: 'example.com', extension: 'com' }],
      pagination: { hasMore: false },
    }));
    expect((await u.getDomain('Example.com')).domainName).toBe('example.com');

    const u2 = ud();
    stubHttp(u2, () => ({ domains: [], pagination: { hasMore: false } }));
    await expect(u2.getDomain('missing.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getNameservers reads the nameservers action', async () => {
    const u = ud();
    stubHttp(u, () => ({
      nameservers: ['ns1.example.net', 'ns2.example.net'],
      isUsingDefaultNameservers: false,
    }));
    expect(await u.getNameservers('example.com')).toEqual(['ns1.example.net', 'ns2.example.net']);
  });

  it('updateNameservers posts the custom-nameservers payload', async () => {
    const u = ud();
    const calls = stubHttp(u, () => OK_WRITE);
    const res = await u.updateNameservers('example.com', ['a.ns.net', 'b.ns.net']);
    expect(calls[0].path).toBe('/mcp/v1/actions/ud_dns_nameservers_set_custom');
    expect(calls[0].body).toMatchObject({
      domains: [{ name: 'example.com', nameservers: ['a.ns.net', 'b.ns.net'] }],
    });
    expect(res.success).toBe(true);
  });

  it('checkAvailability converts cents to major units and flags aftermarket', async () => {
    const u = ud();
    stubHttp(u, () => ({
      results: [
        {
          name: 'free.com',
          available: true,
          marketplace: { status: 'available' },
          pricing: { amount: 999, currency: 'USD' },
        },
        {
          name: 'taken.com',
          available: false,
          marketplace: { status: 'registered-listed-for-sale' },
          pricing: { amount: 500000, currency: 'USD' },
        },
      ],
    }));
    const [a, b] = await u.checkAvailability(['free.com', 'taken.com']);
    expect(a).toEqual({ domainName: 'free.com', available: true, price: 9.99, currency: 'USD' });
    expect(b).toMatchObject({
      domainName: 'taken.com',
      available: false,
      premium: true,
      price: 5000,
    });
  });

  it('getPricing prices a bare TLD via a probe label', async () => {
    const u = ud();
    const calls = stubHttp(u, () => ({
      results: [
        { name: 'ud-registrar-client-probe.io', pricing: { amount: 3499, currency: 'USD' } },
      ],
    }));
    const p = await u.getPricing('io');
    expect(calls[0].body).toMatchObject({ tlds: ['io'] });
    expect(p).toEqual({ tld: 'io', currency: 'USD', registration: 34.99 });
  });

  it('setAutoRenew maps the boolean to enable/disable', async () => {
    const u = ud();
    const calls = stubHttp(u, () => OK_WRITE);
    await u.setAutoRenew('example.com', true);
    await u.setAutoRenew('example.com', false);
    expect(calls[0].body).toMatchObject({ action: 'enable' });
    expect(calls[1].body).toMatchObject({ action: 'disable' });
  });

  it('getDnsRecords expands multi-value records and splits MX priority', async () => {
    const u = ud();
    stubHttp(u, () => ({
      records: [
        { id: '1', type: 'A', subName: 'www', values: ['1.1.1.1', '2.2.2.2'], ttl: 3600 },
        { id: '2', type: 'MX', subName: '', values: ['10 mail.example.com'], ttl: 3600 },
      ],
      pagination: { hasMore: false },
    }));
    const recs = await u.getDnsRecords('example.com');
    expect(recs).toEqual([
      { type: 'A', name: 'www', value: '1.1.1.1', ttl: 3600 },
      { type: 'A', name: 'www', value: '2.2.2.2', ttl: 3600 },
      { type: 'MX', name: '@', value: 'mail.example.com', ttl: 3600, priority: 10 },
    ]);
  });

  it('setDnsRecords clears then re-adds grouped by type+host', async () => {
    const u = ud();
    const calls = stubHttp(u, () => OK_WRITE);
    const res = await u.setDnsRecords('example.com', [
      { type: 'A', name: 'www', value: '1.1.1.1', ttl: 3600 },
      { type: 'A', name: 'www', value: '2.2.2.2', ttl: 3600 },
      { type: 'MX', name: '@', value: 'mail.example.com', priority: 10 },
    ]);
    expect(calls.map(c => c.path?.split('/').pop())).toEqual([
      'ud_dns_records_remove_all',
      'ud_dns_record_add',
    ]);
    const addBody = calls[1].body as {
      records: { type: string; subName: string; values: string[] }[];
    };
    expect(addBody.records).toEqual([
      {
        domain: 'example.com',
        type: 'A',
        subName: 'www',
        values: ['1.1.1.1', '2.2.2.2'],
        ttl: 3600,
      },
      { domain: 'example.com', type: 'MX', subName: '', values: ['10 mail.example.com'] },
    ]);
    expect(res.success).toBe(true);
  });

  it('setDnsRecords with an empty list just clears', async () => {
    const u = ud();
    const calls = stubHttp(u, () => OK_WRITE);
    const res = await u.setDnsRecords('example.com', []);
    expect(calls.map(c => c.path?.split('/').pop())).toEqual(['ud_dns_records_remove_all']);
    expect(res).toEqual({ success: true, message: 'DNS records cleared' });
  });

  it('getDomainForwarding returns only 301/302 redirects', async () => {
    const u = ud();
    stubHttp(u, () => ({
      configs: [
        { type: 'REDIRECT_301', subName: '', targetUrl: 'https://dest.com' },
        { type: 'LISTING_PAGE', subName: '', targetUrl: null },
        { type: 'REDIRECT_302', subName: 'www', targetUrl: 'https://dest.com/www' },
      ],
    }));
    const fwd = await u.getDomainForwarding('example.com');
    expect(fwd).toEqual([
      { host: '@', url: 'https://dest.com', type: 'permanent' },
      { host: 'www', url: 'https://dest.com/www', type: 'temporary' },
    ]);
  });

  it('setDomainForwarding removes existing redirects then adds, and rejects masked', async () => {
    const u = ud();
    const calls = stubHttp(u, action =>
      action === 'ud_dns_hosting_list'
        ? { configs: [{ type: 'REDIRECT_301', subName: '', targetUrl: 'https://old.com' }] }
        : OK_WRITE
    );
    const res = await u.setDomainForwarding('example.com', [
      { host: '@', url: 'https://new.com', type: 'temporary' },
    ]);
    expect(calls.map(c => c.path?.split('/').pop())).toEqual([
      'ud_dns_hosting_list',
      'ud_dns_hosting_remove',
      'ud_dns_hosting_add',
    ]);
    expect(calls[2].body).toMatchObject({
      domains: [{ name: 'example.com', type: 'REDIRECT_302', targetUrl: 'https://new.com' }],
    });
    expect(res.success).toBe(true);

    const u2 = ud();
    stubHttp(u2, () => OK_WRITE);
    await expect(
      u2.setDomainForwarding('example.com', [{ host: '@', url: 'https://x.com', type: 'masked' }])
    ).rejects.toThrow(/masked/i);
  });

  it('out-of-scope / unsupported methods throw NotImplementedError with a reason', async () => {
    const u = ud();
    stubHttp(u, () => OK_WRITE);
    await expect(u.registerDomain('x.com', { contacts: {} })).rejects.toThrow(/cart/i);
    await expect(u.renewDomain('x.com', 1)).rejects.toThrow(/cart/i);
    await expect(u.transferIn('x.com', { authCode: 'c' })).rejects.toThrow(NotImplementedError);
    await expect(u.lockDomain('x.com')).rejects.toThrow(/transfer-lock/i);
    await expect(u.setPrivacy('x.com', true)).rejects.toThrow(NotImplementedError);
    await expect(u.getContacts('x.com')).rejects.toThrow(/account-level/i);
    await expect(u.updateContacts('x.com', {})).rejects.toThrow(NotImplementedError);
  });
});
