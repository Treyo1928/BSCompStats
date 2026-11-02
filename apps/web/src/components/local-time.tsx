'use client';

/**
 * A time of day in the viewer's own clock. Drawn on the server it would be in
 * the server's time zone, which on match night is nobody's.
 */
export function LocalTime({ at }: { at: string }) {
  return (
    <time dateTime={at} suppressHydrationWarning>
      {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </time>
  );
}

/** A day in the viewer's own calendar, e.g. "Oct 1, 2026". */
export function LocalDate({ at }: { at: string }) {
  return (
    <time dateTime={at} suppressHydrationWarning>
      {new Date(at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
    </time>
  );
}
