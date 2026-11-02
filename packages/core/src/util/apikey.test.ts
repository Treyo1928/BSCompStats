import { describe, it, expect } from 'vitest';
import { apiKeyFromHeaders, generateApiKey, hashApiKey, looksLikeApiKey } from './apikey.js';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe('API keys', () => {
  it('makes distinct, well-formed keys whose hash is all that needs storing', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(looksLikeApiKey(a.key)).toBe(true);
    expect(a.key.startsWith(a.prefix)).toBe(true);
    expect(a.prefix).toHaveLength(11);
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.hash).not.toContain(a.key.slice(5));
  });

  it('reads a key from Authorization: Bearer or X-API-Key, and nothing else', () => {
    const { key } = generateApiKey();
    expect(apiKeyFromHeaders(headers({ authorization: `Bearer ${key}` }))).toBe(key);
    expect(apiKeyFromHeaders(headers({ 'x-api-key': key }))).toBe(key);
    expect(apiKeyFromHeaders(headers({ authorization: 'Bearer nope' }))).toBeNull();
    expect(apiKeyFromHeaders(headers({}))).toBeNull();
  });

  it('rejects look-alikes', () => {
    expect(looksLikeApiKey('bscs_short')).toBe(false);
    expect(looksLikeApiKey('bk_' + 'a'.repeat(42))).toBe(false);
    expect(looksLikeApiKey('bscs_' + 'a'.repeat(39) + '!')).toBe(false);
  });
});
