import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';

/**
 * Fetching a URL a user typed, from inside the compose network.
 *
 * Without a guard this is a way to make the server talk to Redis, Postgres, a
 * cloud metadata endpoint, or anything else only it can reach. So: public
 * addresses only, re-checked on every redirect hop, with a size cap, and no
 * detail about the failure handed back to the person probing.
 *
 * The address that was checked is the one connected to. Checking a name and
 * then letting the socket resolve it again is a hole - a record with a short
 * TTL can answer public to the check and private to the connection - so the
 * connection is made through a resolver that only hands back addresses the
 * check has already passed.
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

/** Resolves the host, refuses anything private, and returns what may be connected to. */
async function resolvePublic(url: URL): Promise<LookupAddress[]> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UnsafeUrlError();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses: LookupAddress[] = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError();
  }
  return addresses;
}

/** A dispatcher whose connections can only go to the addresses already checked. */
function pinnedAgent(host: string, addresses: LookupAddress[]): Agent {
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        if (hostname !== host) {
          callback(new UnsafeUrlError(), [] as never);
          return;
        }
        const results = addresses.map((a) => ({ address: a.address, family: a.family }));
        if (options.all) callback(null, results as never);
        else callback(null, results[0]!.address as never, results[0]!.family as never);
      },
    },
  });
}

/** GETs JSON from a public URL. Throws UnsafeUrlError or a plain Error - never with detail. */
export async function fetchPublicJson(rawUrl: string, maxBytes: number): Promise<unknown> {
  let url = new URL(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await resolvePublic(url);
    const agent = pinnedAgent(host, addresses);
    try {
      const response = await undiciFetch(url, {
        dispatcher: agent,
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

      const body = await readCapped(response.body, maxBytes);
      if (!body) break;
      return JSON.parse(new TextDecoder().decode(body));
    } finally {
      await agent.close();
    }
  }

  throw new Error('fetch failed');
}

/**
 * Reads a body up to the cap and gives up the moment it is passed. A server
 * that omits content-length used to have the whole thing buffered before
 * the size was looked at.
 */
async function readCapped(body: UndiciResponse['body'], maxBytes: number): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
