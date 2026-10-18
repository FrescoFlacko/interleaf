import { describe, expect, it } from 'vitest';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  assertAllowedAddress,
  assertRequestUrl,
  isBlockedAddress,
  toProvenanceUrl,
} from '@main/net/address-policy';
import { thrownBy } from '../helpers/errors';

/**
 * The address policy is the load-bearing SSRF control: every destination the
 * fetcher is ever allowed to reach passes through it, so these tests treat it as
 * the boundary itself rather than as a helper. Each case is an address or URL an
 * attacker could plausibly submit or redirect to, and the expectation is always
 * that the policy refuses rather than that it merely warns.
 */

function expectRejects(url: string): InterleafError {
  const error = thrownBy(() => { assertRequestUrl(url); });
  if (!(error instanceof InterleafError)) throw new Error(`expected ${url} to be rejected with an InterleafError`);
  expect(error.code).toBe('security-violation');
  return error;
}

describe('web article address policy', () => {
  describe('scheme, credentials, and port', () => {
    it('accepts ordinary public http and https article URLs', () => {
      const https = assertRequestUrl('https://example.com/posts/why-margins');
      expect(https.hostname).toBe('example.com');
      expect(https.port).toBe(443);
      expect(https.isIpLiteral).toBe(false);

      const http = assertRequestUrl('http://news.example.co.uk/a?b=1#frag');
      expect(http.port).toBe(80);
    });

    it('rejects every scheme other than http and https', () => {
      for (const url of [
        'file:///etc/passwd',
        'ftp://example.com/a',
        'gopher://example.com/1',
        'data:text/html,<script>alert(1)</script>',
        'javascript:alert(1)',
        'ws://example.com/socket',
        'interleaf-asset://example.com/a',
      ]) {
        expectRejects(url);
      }
    });

    it('rejects embedded credentials in either position', () => {
      expectRejects('https://user@example.com/a');
      expectRejects('https://user:secret@example.com/a');
      expectRejects('https://:secret@example.com/a');
    });

    it('rejects nonstandard ports, including internal service ports', () => {
      for (const url of [
        'http://example.com:8080/a',
        'https://example.com:8443/a',
        'https://example.com:22/a',
        'https://example.com:6379/a',
        'http://example.com:443/a',
        'https://example.com:80/a',
      ]) {
        expectRejects(url);
      }
    });

    it('accepts an explicit default port that matches the scheme', () => {
      expect(assertRequestUrl('https://example.com:443/a').port).toBe(443);
      expect(assertRequestUrl('http://example.com:80/a').port).toBe(80);
    });

    it('rejects strings that are not absolute URLs at all', () => {
      for (const url of ['', 'example.com/a', '//example.com/a', 'https://', 'not a url']) {
        expectRejects(url);
      }
    });
  });

  describe('host names', () => {
    it('rejects single-label and internal-style host names', () => {
      for (const url of [
        'http://localhost/a',
        'http://intranet/a',
        'http://build-server/a',
        'http://metadata/a',
      ]) {
        expectRejects(url);
      }
    });

    it('rejects malformed labels, trailing dots, and oversized names', () => {
      expectRejects('https://example..com/a');
      expectRejects('https://example.com./a');
      expectRejects('https://-example.com/a');
      expectRejects('https://example-.com/a');
      expectRejects(`https://${'a'.repeat(64)}.com/a`);
      expectRejects(`https://${`${'a'.repeat(60)}.`.repeat(5)}com/a`);
    });

    it('rejects a host name whose characters could confuse a downstream parser', () => {
      expectRejects('https://exa_mple.com/a');
      expectRejects('https://ex ample.com/a');
    });

    it('checks the normalized host, so percent-encoding cannot smuggle a blocked one', () => {
      // `URL` decodes and lowercases the host before the policy sees it, so the
      // policy always judges the host the socket would actually connect to.
      expect(assertRequestUrl('https://EXAM%70LE.com/a').hostname).toBe('example.com');
      expectRejects('http://%31%32%37.0.0.1/a');
    });
  });

  describe('IPv4 destinations', () => {
    it('blocks loopback, private, link-local, CGNAT, and reserved ranges', () => {
      for (const address of [
        '127.0.0.1',
        '127.1.2.3',
        '0.0.0.0',
        '0.1.2.3',
        '10.0.0.1',
        '10.255.255.254',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '100.127.255.255',
        '192.0.0.1',
        '192.0.2.5',
        '192.88.99.1',
        '198.18.0.1',
        '198.51.100.5',
        '203.0.113.5',
        '224.0.0.1',
        '239.255.255.250',
        '255.255.255.255',
      ]) {
        expect(isBlockedAddress(address), `${address} must be blocked`).toBe(true);
      }
    });

    it('allows ordinary public unicast addresses', () => {
      for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1']) {
        expect(isBlockedAddress(address), `${address} must be allowed`).toBe(false);
      }
    });

    it('rejects the cloud metadata address through a URL literal', () => {
      expectRejects('http://169.254.169.254/latest/meta-data/');
    });
  });

  describe('IPv6 destinations', () => {
    it('blocks loopback, unspecified, unique-local, link-local, multicast, and IANA special-purpose ranges', () => {
      for (const address of [
        '::1',
        '::',
        'fc00::1',
        'fd12:3456:789a::1',
        'fe80::1',
        'fe80::1%en0',
        'fec0::1',
        'ff02::1',
        'ff00::',
        '100::1',
        '2001:db8::1',
        '2001:2::1', // RFC 5180 Benchmarking
        '2001:2:0:0:0:0:0:1',
        '3fff::1', // RFC 9637 Documentation
        '3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff',
        '5f00::1', // Non-global unallocated (outside 2000::/3)
        '5f00::',
        '4000::1',
        '0100::1',
        '2001:1::1', // PCP/TURN anycast
        '2001:3::1', // AMT
        '2001:4:112::1', // AS112-v6
        '2001:5::1', // LISP EID
        '2001:10::1', // ORCHID
        '2001:20::1', // ORCHIDv2
        '2001:30::1', // Drone Remote ID
        '2001:100::1', // IANA 2001::/23 special-purpose parent gap
        '2001:1ff::1', // IANA 2001::/23 special-purpose parent gap
        '2620:4f:8000::1', // AS112
      ]) {
        expect(isBlockedAddress(address), `${address} must be blocked`).toBe(true);
      }
    });

    it('blocks every IPv4-derived encoding rather than unwrapping it', () => {
      for (const address of [
        '::ffff:127.0.0.1',
        '::ffff:169.254.169.254',
        '::ffff:8.8.8.8',
        '::127.0.0.1',
        '64:ff9b::127.0.0.1',
        '2002:7f00:1::1',
        '2001:0:5ef5:79fd:8:7d2e:8000:1',
      ]) {
        expect(isBlockedAddress(address), `${address} must be blocked`).toBe(true);
      }
    });

    it('allows public IPv6 unicast within 2000::/3', () => {
      for (const address of [
        '2606:4700:4700::1111',
        '2a00:1450:4001:80e::200e',
        '2607:f8b0:4005:805::200e',
        '2001:4860:4860::8888',
        '3fff:1000::1', // Outside 3fff::/20
      ]) {
        expect(isBlockedAddress(address), `${address} must be allowed`).toBe(false);
      }
    });

    it('rejects blocked IPv6 literals written as bracketed URL hosts', () => {
      expectRejects('http://[::1]/a');
      expectRejects('http://[fd00::1]/a');
      expectRejects('http://[::ffff:169.254.169.254]/a');
    });

    it('accepts a public IPv6 literal and reports it unbracketed', () => {
      const validated = assertRequestUrl('https://[2606:4700:4700::1111]/a');
      expect(validated.isIpLiteral).toBe(true);
      expect(validated.hostname).toBe('2606:4700:4700::1111');
    });
  });

  describe('unparsable input', () => {
    it('treats anything that is not a concrete IP address as blocked', () => {
      for (const address of ['', ' ', 'example.com', 'not-an-address', '1.2.3', '1.2.3.4.5', '12345', 'fg::1']) {
        expect(isBlockedAddress(address), `${address} must be blocked`).toBe(true);
      }
    });

    it('assertAllowedAddress throws a typed security violation with a static message', () => {
      const error = thrownBy(() => { assertAllowedAddress('10.0.0.5'); });
      if (!(error instanceof InterleafError)) throw new Error('expected an InterleafError');
      expect(error.code).toBe('security-violation');
      // The destination class is named; the address the attacker chose is not
      // echoed back, so the message cannot be used to confirm a probe.
      expect(error.message).not.toContain('10.0.0.5');
    });
  });

  describe('provenance URLs', () => {
    it('strips credentials and fragments while keeping the identifying path', () => {
      const url = new URL('https://user:pw@example.com/posts/a?utm=1#section');
      expect(toProvenanceUrl(url, 2048)).toBe('https://example.com/posts/a?utm=1');
    });

    it('rejects an overlong stored length rather than truncating it', () => {
      const long = new URL(`https://example.com/${'a'.repeat(5000)}`);
      expect(() => toProvenanceUrl(long, 100)).toThrow(InterleafError);
    });
  });
});
