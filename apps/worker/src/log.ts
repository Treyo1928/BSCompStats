/** Structured-ish logging. Docker collects stdout, so that is where it goes. */
const stamp = () => new Date().toISOString();

export const log = {
  info: (msg: string, extra?: unknown) =>
    console.log(`${stamp()} INFO  ${msg}${fmt(extra)}`),
  warn: (msg: string, extra?: unknown) =>
    console.warn(`${stamp()} WARN  ${msg}${fmt(extra)}`),
  error: (msg: string, extra?: unknown) =>
    console.error(`${stamp()} ERROR ${msg}${fmt(extra)}`),
};

function fmt(extra: unknown): string {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ` - ${extra.message}`;
  return ` ${JSON.stringify(extra)}`;
}
