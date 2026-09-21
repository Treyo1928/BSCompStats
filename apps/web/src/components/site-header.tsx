import Link from 'next/link';
import { prisma } from '@bscs/db';
import { currentUser } from '@/server/session';
import { signOut } from '@/lib/auth';
import { hasBeatLeaderAuth, hasDiscordAuth } from '@/lib/env';
import { Avatar } from './ui';

export async function SiteHeader() {
  const user = await currentUser();
  const authConfigured = hasDiscordAuth || hasBeatLeaderAuth;

  // Signed in through Discord but with no BeatLeader profile attached: offer
  // to link one. Signing in with a second provider while a session exists
  // attaches it to the current account instead of creating another.
  const canLinkBeatLeader =
    user?.id && hasBeatLeaderAuth
      ? !(await prisma.account.findFirst({
          where: { userId: user.id, provider: 'beatleader' },
          select: { id: true },
        }))
      : false;

  return (
    <header className="sticky top-0 z-30 border-b border-edge bg-surface/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-2.5">
        <Link href="/" className="group flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">
            BSComp<span className="text-muted group-hover:text-ink">Stats</span>
          </span>
        </Link>

        <nav className="flex items-center gap-1 text-sm text-muted">
          <Link href="/" className="rounded-lg px-3 py-1.5 hover:bg-raised hover:text-ink">
            Tournaments
          </Link>
          {user ? (
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/' });
              }}
              className="ml-2 flex items-center gap-2 border-l border-edge pl-3"
            >
              {canLinkBeatLeader && (
                <Link
                  href="/signin"
                  className="rounded-lg border border-edge px-2.5 py-1 text-xs hover:border-faint hover:text-ink"
                  title="Attach your BeatLeader profile so your scores are attributed to you"
                >
                  Link BeatLeader
                </Link>
              )}
              <Avatar src={user.image} name={user.name ?? '?'} size={26} />
              <span className="hidden text-ink sm:inline">{user.name ?? 'Signed in'}</span>
              <button className="rounded-lg px-2 py-1.5 hover:bg-raised hover:text-ink" type="submit">
                Sign out
              </button>
            </form>
          ) : authConfigured ? (
            <Link
              href="/signin"
              className="ml-2 rounded-lg bg-accent px-3 py-1.5 font-medium text-white hover:brightness-110"
            >
              Sign in
            </Link>
          ) : (
            <Link
              href="/signin"
              className="ml-2 rounded-lg border border-dashed border-edge px-3 py-1.5 text-xs hover:text-ink"
              title="No sign-in provider is configured yet - see docs/auth-setup.md"
            >
              Set up sign-in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

/** Two crossed sabers. */
function Logo() {
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-raised ring-1 ring-white/10">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
        <path d="M5 19 19 5" stroke="var(--color-saber-left)" />
        <path d="M5 5l14 14" stroke="var(--color-saber-right)" />
      </svg>
    </span>
  );
}
