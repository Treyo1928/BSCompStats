import Link from 'next/link';
import { signIn } from '@/lib/auth';
import { currentUser } from '@/server/session';
import { env, hasBeatLeaderAuth, hasDiscordAuth } from '@/lib/env';
import { Panel } from '@/components/ui';

export default async function SignInPage() {
  const user = await currentUser();
  const none = !hasDiscordAuth && !hasBeatLeaderAuth;

  return (
    <div className="mx-auto max-w-md pt-10">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {user ? 'Link another account' : 'Sign in'}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {user
            ? `You are signed in as ${user.name ?? 'your account'}. Continuing with another provider attaches it to this account.`
            : 'Captains and organisers sign in to pick, ban and set lineups. Viewing is open.'}
        </p>
      </div>

      <Panel>
        {none ? (
          <div className="space-y-3 text-sm text-muted">
            <p className="font-medium text-ink">No sign-in method is configured yet.</p>
            <p>
              Register an OAuth app with Discord or BeatLeader, put its client ID and secret in
              your <Code>.env</Code>, and restart. The full walkthrough is in{' '}
              <Code>docs/auth-setup.md</Code>.
            </p>
            <p>Redirect URIs to register for this instance:</p>
            <ul className="space-y-1">
              <li>
                <Code>{env.APP_URL}/api/auth/callback/discord</Code>
              </li>
              <li>
                <Code>{env.APP_URL}/api/auth/callback/beatleader</Code>
              </li>
            </ul>
          </div>
        ) : (
          <div className="space-y-3">
            {hasBeatLeaderAuth && (
              <form
                action={async () => {
                  'use server';
                  await signIn('beatleader', { redirectTo: '/' });
                }}
              >
                <button
                  type="submit"
                  className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-gradient-to-r from-[#c92d77] to-[#8b3fe6] px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                    <path d="M5 19 19 5M5 5l14 14" stroke="currentColor" />
                  </svg>
                  Continue with BeatLeader
                </button>
              </form>
            )}
            {hasDiscordAuth && (
              <form
                action={async () => {
                  'use server';
                  await signIn('discord', { redirectTo: '/' });
                }}
              >
                <button
                  type="submit"
                  className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-[#5865F2] px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 6.5C7 5.5 9.5 5 12 5s5 .5 7 1.5c1.5 3 2.3 6.2 2 10-1.5 1.2-3.2 2-5 2.5l-1-2M5 6.5c-1.5 3-2.3 6.2-2 10 1.5 1.2 3.2 2 5 2.5l1-2" />
                    <circle cx="9" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
                    <circle cx="15" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
                  </svg>
                  Continue with Discord
                </button>
              </form>
            )}
            {hasBeatLeaderAuth && (
              <p className="pt-1 text-xs text-muted">
                Signing in with BeatLeader also links your player profile, so your scores are
                picked up automatically.
              </p>
            )}
          </div>
        )}
      </Panel>

      <p className="mt-4 text-center text-xs text-faint">
        <Link href="/" className="hover:text-ink">
          Back to tournaments
        </Link>
      </p>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="break-all rounded bg-raised px-1.5 py-0.5 text-[12px] text-ink">{children}</code>
  );
}
