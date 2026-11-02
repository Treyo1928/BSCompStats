import { createHash, randomBytes } from 'node:crypto';

/**
 * API keys look like `bscs_` + 40 letters and digits, so they are easy to spot
 * in a config file or a secret scanner. Only a SHA-256 of the key is stored:
 * a database leak gives nobody a working key.
 */
export const API_KEY_PREFIX = 'bscs_';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BODY_LENGTH = 40;
const SHOWN = 6;

export interface NewApiKey {
  /** The whole key. Shown to its owner once, then forgotten. */
  key: string;
  /** What the key list shows: "bscs_ab12cd". */
  prefix: string;
  /** What is stored and looked up. */
  hash: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): NewApiKey {
  // Rejection sampling keeps every character equally likely (256 is not a multiple of 62).
  let body = '';
  while (body.length < BODY_LENGTH) {
    for (const b of randomBytes(BODY_LENGTH)) {
      if (b < 248 && body.length < BODY_LENGTH) body += ALPHABET[b % 62];
    }
  }
  const key = API_KEY_PREFIX + body;
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + SHOWN), hash: hashApiKey(key) };
}

/** Whether a string has the shape of a key (cheap check before a database lookup). */
export function looksLikeApiKey(value: string): boolean {
  return value.length === API_KEY_PREFIX.length + BODY_LENGTH && value.startsWith(API_KEY_PREFIX) && /^[A-Za-z0-9]+$/.test(value.slice(API_KEY_PREFIX.length));
}

/**
 * The key from a request: `Authorization: Bearer bscs_…`, or an `X-API-Key` header.
 * Query strings are deliberately not accepted - URLs end up in logs and OBS settings.
 */
export function apiKeyFromHeaders(headers: { get(name: string): string | null }): string | null {
  const auth = headers.get('authorization');
  const bearer = auth && /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  const key = bearer || headers.get('x-api-key')?.trim() || null;
  return key && looksLikeApiKey(key) ? key : null;
}
