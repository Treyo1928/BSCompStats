import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button, Panel } from '@/components/ui';
import { askForAccess } from '@/server/api-key-actions';
import { accessTo, mintCode, returnsTo, signInKey } from '@/server/connect';
import { realUser } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * "Sign in with BSCompStats", the site's half (see server/connect.ts). An app sends its visitor here with its key's
 * id, where to come back to, and a `state` of its own. Someone who may use the app goes straight back with a code;
 * anyone else is told why not, and can ask the key's user to let them in.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; redirect_uri?: string; state?: string }>;
}) {
  const { key: keyId = '', redirect_uri: returnTo = '', state = '' } = await searchParams;
  const here = `/connect/authorize?${new URLSearchParams({ key: keyId, redirect_uri: returnTo, state })}`;

  const key = await signInKey(keyId);
  // Checked before anything is said about the visitor, and nobody is ever sent to an address the key does not name.
  if (!key || !returnsTo(key.signInUrl, returnTo) || state.length > 200) {
    return (
      <Notice title="This sign-in link does not work">
        <p>
          The app that sent you here is not set up for signing in with BSCompStats, or its key was revoked or has
          expired. Whoever runs the app can fix that on their API keys page (the key needs the app&apos;s address as its
          sign-in address).
        </p>
      </Notice>
    );
  }

  const user = await realUser();
  if (!user) redirect(`/signin?next=${encodeURIComponent(here)}`);

  const access = await accessTo(key, user.id);
  if (access === 'yes') {
    const back = new URL(returnTo);
    back.searchParams.set('code', await mintCode(key.id, user.id));
    if (state) back.searchParams.set('state', state);
    redirect(back.toString());
  }

  const owner = key.owner.name ?? 'the person who runs it';
  const app = new URL(key.signInUrl).host;
  return (
    <Notice title={access === 'asked' ? `Waiting for ${owner}` : `Ask to use ${app}`}>
      <p>
        You are signed in as <span className="font-medium text-ink">{user.name ?? 'your account'}</span>. <span className="font-medium text-ink">{app}</span>{' '}
        (&ldquo;{key.name}&rdquo;) is run by {owner}, who decides who may sign in to it.
      </p>
      {access === 'asked' ? (
        <>
          <p>
            You have asked. {owner} sees your request on their API keys page; once they approve it, come back here and you
            are let in.
          </p>
          <Link href={here} className="inline-flex h-9 items-center rounded-lg border border-edge px-3 text-sm font-medium text-ink hover:border-faint">
            Try again
          </Link>
        </>
      ) : (
        <form action={askForAccess}>
          <input type="hidden" name="keyId" value={key.id} />
          <Button type="submit">Ask {owner} to let me in</Button>
        </form>
      )}
    </Notice>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md pt-10">
      <Panel title={title}>
        <div className="space-y-3 text-sm text-muted">{children}</div>
      </Panel>
    </div>
  );
}
