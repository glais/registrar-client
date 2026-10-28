import { describe, it, expect } from 'vitest';
import { createRegistrar, registrars, NotFoundError, NotImplementedError } from '../src/index';
import type { RequestConfig } from '../src/http';

// Above.com speaks XML over HttpClient.requestText only. Stub it; the handler
// receives each RequestConfig and returns the canned XML body (keyed off the
// `query` function name for multi-call flows).
function stubHttp(provider: unknown, handler: (req: RequestConfig) => string): RequestConfig[] {
  const calls: RequestConfig[] = [];
  (
    provider as { http: { requestText: (req: RequestConfig) => Promise<string> } }
  ).http.requestText = (req: RequestConfig) => {
    calls.push(req);
    return Promise.resolve(handler(req));
  };
  return calls;
}

function above() {
  return createRegistrar('above', { apiKey: 'APIKEY' });
}

// the function name this request is invoking (the `query` parameter)
function fn(req: RequestConfig): string {
  return String(req.query?.query ?? '');
}

const OK_EMPTY = '<results code="100" />';

function domainRow(name: string, extra = ''): string {
  return `<r domain="${name}">
    <created>2014-05-06 03:47:40</created>
    <expiry>2018-05-06 03:47:40</expiry>
    <dns1>ns1.abovedomains.com</dns1>
    <dns2>ns2.abovedomains.com</dns2>
    <registrant_contact>260152_673371</registrant_contact>
    <admin_contact>260152_673371</admin_contact>
    <technical_contact>260152_673371</technical_contact>
    <billing_contact>260152_673371</billing_contact>
    <privacy>on</privacy>
    <autorenew>off</autorenew>
    <status>ok</status>
    <lock>On</lock>
    <lock_type>Client</lock_type>
    ${extra}
  </r>`;
}

describe('Above.com provider', () => {
  it('discovery metadata is exposed statically', () => {
    const Above = registrars.above;
    expect(Above.displayName).toBe('Above.com');
    expect(Above.website).toBe('above.com');
    expect(Above.supportsSandbox).toBe(false);
    expect(Above.configFields.map(f => f.name)).toEqual(['apiKey']);
    expect(Above.features).toContain('getAuthCode');
  });

  it('sends the API key as a Bearer header, never in the query string', async () => {
    const ab = above();
    const calls = stubHttp(ab, () => '<results code="100"><balance>351.60</balance></results>');
    const res = await ab.testConnection();
    expect(res.success).toBe(true);
    expect(fn(calls[0])).toBe('balance');
    // the key is not a query parameter
    expect(JSON.stringify(calls[0].query)).not.toContain('APIKEY');
  });

  it('getDomain maps a manage_domains row to a normalized domain', async () => {
    const ab = above();
    const calls = stubHttp(
      ab,
      () =>
        `<results code="100"><domains total="1" offset="0" limit="100">${domainRow(
          'example.com'
        )}</domains></results>`
    );
    const d = await ab.getDomain('Example.com');
    expect(fn(calls[0])).toBe('manage_domains');
    expect(calls[0].query).toMatchObject({ domain: 'example.com' });
    expect(d).toMatchObject({
      domainName: 'example.com',
      registrar: 'above',
      status: 'ok',
      autoRenew: false,
      locked: true,
      privacy: true,
      nameservers: ['ns1.abovedomains.com', 'ns2.abovedomains.com'],
    });
    // dates are read as UTC, not local
    expect(d.createdDate?.toISOString()).toBe('2014-05-06T03:47:40.000Z');
    expect(d.expirationDate?.toISOString()).toBe('2018-05-06T03:47:40.000Z');
  });

  it('getDomain throws NotFoundError when the domain is not in the account', async () => {
    const ab = above();
    stubHttp(
      ab,
      () => '<results code="509"><msg>Specified domain is not in your account</msg></results>'
    );
    await expect(ab.getDomain('missing.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getNameservers drops the "NO" placeholder', async () => {
    const ab = above();
    stubHttp(
      ab,
      () =>
        `<results code="100"><domains total="1"><r domain="x.com"><dns1>NO</dns1><dns2>NO</dns2><status>ok</status></r></domains></results>`
    );
    expect(await ab.getNameservers('x.com')).toEqual([]);
  });

  it('listDomains paginates by offset and stops on "No domains found"', async () => {
    const ab = above();
    const page = Array.from({ length: 1000 }, (_, i) => domainRow(`d${i}.com`)).join('');
    const calls = stubHttp(ab, req => {
      const offset = Number(req.query?.offset ?? 0);
      if (offset === 0)
        return `<results code="100"><domains total="1001" offset="0" limit="1000">${page}</domains></results>`;
      // second page: one row, under the page size -> loop ends
      return `<results code="100"><domains total="1001" offset="1000" limit="1000">${domainRow(
        'last.com'
      )}</domains></results>`;
    });
    const all = await ab.listDomains();
    expect(all).toHaveLength(1001);
    expect(calls.map(c => c.query?.offset)).toEqual([0, 1000]);
  });

  it('listDomains returns [] for an empty account (2001)', async () => {
    const ab = above();
    stubHttp(ab, () => '<results code="2001"><msg>No domains found</msg></results>');
    expect(await ab.listDomains()).toEqual([]);
  });

  it('listDomains applies the search filter client-side', async () => {
    const ab = above();
    stubHttp(
      ab,
      () =>
        `<results code="100"><domains total="2" limit="1000">${domainRow('keep-me.com')}${domainRow(
          'other.net'
        )}</domains></results>`
    );
    const found = await ab.listDomains({ search: 'keep' });
    expect(found.map(d => d.domainName)).toEqual(['keep-me.com']);
  });

  it('getPricing finds the TLD row and returns major USD units', async () => {
    const ab = above();
    stubHttp(
      ab,
      () => `<results code="100">
        <r tld="biz"><register>9.95</register><renew>9.95</renew><transfer>9.95</transfer><restore>100.00</restore></r>
        <r tld="com"><register>8.88</register><renew>10.95</renew><transfer>9.00</transfer><restore>N/A</restore></r>
      </results>`
    );
    // a full domain is reduced to its TLD
    expect(await ab.getPricing('example.com')).toEqual({
      tld: 'com',
      currency: 'USD',
      registration: 8.88,
      renewal: 10.95,
      transfer: 9.0,
    });
  });

  it('renewDomain passes renew_year and reports success on code 100', async () => {
    const ab = above();
    const calls = stubHttp(ab, () => OK_EMPTY);
    const res = await ab.renewDomain('shoes.com', 2);
    expect(fn(calls[0])).toBe('renew');
    expect(calls[0].query).toMatchObject({ domain: 'shoes.com', renew_year: 2 });
    expect(res).toEqual({ success: true, message: 'success' });
  });

  it('renewDomain surfaces an API error as a failed OperationResult', async () => {
    const ab = above();
    stubHttp(ab, () => '<results code="803"><msg>Renewal years must be 1-10 years</msg></results>');
    const res = await ab.renewDomain('laces.com', 12);
    expect(res).toEqual({ success: false, message: 'Renewal years must be 1-10 years' });
  });

  it('updateNameservers rejects fewer than two / more than four nameservers', async () => {
    const ab = above();
    const calls = stubHttp(ab, () => OK_EMPTY);
    await expect(ab.updateNameservers('x.com', ['ns1.a.com'])).rejects.toThrow(/between 2 and 4/);
    await expect(ab.updateNameservers('x.com', ['a', 'b', 'c', 'd', 'e'])).rejects.toThrow(
      /between 2 and 4/
    );
    expect(calls).toHaveLength(0); // no request made for an invalid count
  });

  it('updateNameservers sends a comma-joined dns list', async () => {
    const ab = above();
    const calls = stubHttp(ab, () => OK_EMPTY);
    await ab.updateNameservers('x.com', ['ns1.a.com', 'ns2.a.com']);
    expect(fn(calls[0])).toBe('update_dns');
    expect(calls[0].query).toMatchObject({ domain: 'x.com', dns: 'ns1.a.com,ns2.a.com' });
  });

  it('lock/unlock treat the already-in-state codes as idempotent success', async () => {
    const ab = above();
    stubHttp(ab, req =>
      fn(req) === 'lock'
        ? '<results code="1201"><msg>Domain already locked</msg></results>'
        : '<results code="1202"><msg>Domain already unlocked</msg></results>'
    );
    expect((await ab.lockDomain('x.com')).success).toBe(true);
    expect((await ab.unlockDomain('x.com')).success).toBe(true);
  });

  it('setPrivacy maps the boolean to on/off', async () => {
    const ab = above();
    const calls = stubHttp(ab, () => OK_EMPTY);
    await ab.setPrivacy('x.com', true);
    await ab.setPrivacy('x.com', false);
    expect(calls[0].query).toMatchObject({ query: 'privacy', set_privacy: 'on' });
    expect(calls[1].query).toMatchObject({ query: 'privacy', set_privacy: 'off' });
  });

  it('transferIn queues the transfer with the EPP code', async () => {
    const ab = above();
    const calls = stubHttp(ab, () => OK_EMPTY);
    const res = await ab.transferIn('pencils.com', { authCode: 'nB$/4bVm' });
    expect(fn(calls[0])).toBe('transfer');
    expect(calls[0].query).toMatchObject({ domain: 'pencils.com', epp_code: 'nB$/4bVm' });
    expect(res.success).toBe(true);
  });

  it('getAuthCode returns the EPP code', async () => {
    const ab = above();
    stubHttp(ab, () => '<results code="100"><epp_code>8t^KslDOayG</epp_code></results>');
    expect(await ab.getAuthCode('books.com')).toBe('8t^KslDOayG');
  });

  it('getAuthCode throws when the registry only emails the code (e.g. .BE)', async () => {
    const ab = above();
    stubHttp(ab, () => '<results code="100"><msg>Sent to registrant email</msg></results>');
    await expect(ab.getAuthCode('business.be')).rejects.toThrow(/email/i);
  });

  it('registerDomain applies nameservers and privacy as follow-ups', async () => {
    const ab = above();
    const calls = stubHttp(ab, () => OK_EMPTY);
    const res = await ab.registerDomain('shoes.com', {
      contacts: {},
      nameservers: ['ns1.a.com', 'ns2.a.com'],
      privacy: true,
      autoRenew: true,
    });
    expect(calls.map(fn)).toEqual(['register', 'update_dns', 'privacy']);
    expect(res.success).toBe(true);
    // auto-renew can't be set, so the result says so
    expect(res.message).toMatch(/auto-renew/i);
  });

  it('getContacts resolves domain contact identifiers against the contact list', async () => {
    const ab = above();
    const calls = stubHttp(ab, req => {
      if (fn(req) === 'manage_domains')
        return `<results code="100"><domains total="1">${domainRow('example.com')}</domains></results>`;
      // manage_contacts: the alias matches the domain's *_contact value
      return `<results code="100"><contacts total="1" offset="0" limit="1000">
        <r contact="7962">
          <id>7962</id>
          <contact_identifier>260152</contact_identifier>
          <contact_alias>260152_673371</contact_alias>
          <name>Jane Doe</name>
          <company>Acme</company>
          <email>jane@example.com</email>
          <phone>61.123456789</phone>
          <address>123 Main St</address>
          <city>Phoenix</city>
          <state>AZ</state>
          <postcode>85001</postcode>
          <country>US</country>
        </r>
      </contacts></results>`;
    });
    const contacts = await ab.getContacts('example.com');
    expect(calls.map(fn)).toEqual(['manage_domains', 'manage_contacts']);
    expect(contacts.registrant).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      organization: 'Acme',
      email: 'jane@example.com',
      phone: '+61.123456789', // national form gets a leading "+"
      address1: '123 Main St',
      address2: undefined,
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'US',
    });
    expect(contacts.admin).toMatchObject({ firstName: 'Jane' });
  });

  it('unsupported core methods throw NotImplementedError with a specific reason', async () => {
    const ab = above();
    stubHttp(ab, () => OK_EMPTY);
    await expect(ab.checkAvailability(['x.com'])).rejects.toThrow(NotImplementedError);
    await expect(ab.setAutoRenew('x.com', true)).rejects.toThrow(/auto-renew read-only/i);
    await expect(ab.updateContacts('x.com', {})).rejects.toThrow(NotImplementedError);
    await expect(ab.getDnsRecords('x.com')).rejects.toThrow(/only creates records/i);
    await expect(ab.setDnsRecords('x.com', [])).rejects.toThrow(NotImplementedError);
  });

  it('rejects a sandbox environment (Above.com is production-only)', () => {
    expect(() => createRegistrar('above', { apiKey: 'k' }, { environment: 'sandbox' })).toThrow(
      /sandbox/i
    );
  });
});
