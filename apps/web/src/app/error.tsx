'use client';

import { useEffect } from 'react';
import { Button, Panel } from '@/components/ui';

/**
 * Without this, any uncaught error in a page replaces the whole site with
 * Next's bare "Application error" screen, which tells neither the person
 * looking at it nor whoever they report it to anything useful.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Panel title="Something went wrong" subtitle="The page hit an error it could not recover from.">
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-edge bg-surface/80 p-3 text-xs text-muted">
        {error.name}: {error.message}
        {error.digest ? `\nDigest: ${error.digest} (matches an entry in the server log)` : ''}
      </pre>
      <div className="mt-3 flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="ghost" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    </Panel>
  );
}
