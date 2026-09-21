import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Fetching a URL a user typed, from inside the compose network.
 *
 * Without a guard this is a way to make the server talk to Redis, Postgres, a
 * cloud metadata endpoint, or anything else only it can reach. So: public
 * addresses only, re-checked on every redirect hop, with a size cap, and no
 * detail about the failure handed back to the person probing.
 */

const MAX_REDIRECTS = 3;

export class UnsafeUrlError extends Error {}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UnsafeUrlError();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError();
  }
}

/** GETs JSON from a public URL. Throws UnsafeUrlError or a plain Error - never with detail. */
export async function fetchPublicJson(rawUrl: string, maxBytes: number): Promise<unknown> {
  let url = new URL(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/json' },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) break;

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) break;

    const body = await response.arrayBuffer();
    if (body.byteLength > maxBytes) break;
    return JSON.parse(new TextDecoder().decode(body));
  }

  throw new Error('fetch failed');
}
