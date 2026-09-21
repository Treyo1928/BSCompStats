import Link from 'next/link';
import { prisma } from '@bscs/db';
import { cookies } from 'next/headers';
import { currentUser, realUser, VIEW_AS_COOKIE } from '@/server/session';
import { signOut } from '@/lib/auth';
import { hasBeatLeaderAuth, hasDiscordAuth } from '@/lib/env';
import { Avatar } from './ui';

export async function SiteHeader() {
  const user = await currentUser();
  // The Users link follows the real account, so it stays reachable mid view-as.
  const isAdmin = (await realUser())?.role === 'ADMIN';
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
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-2 px-3 py-2.5 sm:gap-4 sm:px-4">
        <Link href="/" className="group flex shrink-0 items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">
            BSComp<span className="text-muted group-hover:text-ink">Stats</span>
          </span>
        </Link>

        <nav className="flex min-w-0 items-center gap-1 text-sm text-muted">
          {/* The logo already goes home, so this is the first thing to give way on a phone. */}
          <Link href="/" className="hidden rounded-lg px-3 py-1.5 hover:bg-raised hover:text-ink sm:block">
            Tournaments
          </Link>
          {isAdmin && (
            <Link href="/admin/users" className="rounded-lg px-3 py-1.5 hover:bg-raised hover:text-ink">
              Users
            </Link>
          )}
          {user ? (
            <form
              action={async () => {
                'use server';
                (await cookies()).delete(VIEW_AS_COOKIE);
                await signOut({ redirectTo: '/' });
              }}
              className="ml-2 flex min-w-0 items-center gap-2 border-l border-edge pl-3"
            >
              {canLinkBeatLeader && (
                <Link
                  href="/signin"
                  className="hidden h-8 shrink-0 items-center whitespace-nowrap rounded-lg border border-edge-strong px-2.5 text-xs hover:border-faint hover:text-ink sm:inline-flex"
                  title="Attach your BeatLeader profile so your scores are attributed to you"
                >
                  Link BeatLeader
                </Link>
              )}
              <Avatar src={user.image} name={user.name ?? '?'} size={26} />
              <span className="hidden max-w-[10rem] truncate text-ink sm:inline">{user.name ?? 'Signed in'}</span>
              <button className="shrink-0 whitespace-nowrap rounded-lg px-2 py-1.5 hover:bg-raised hover:text-ink" type="submit">
                Sign out
              </button>
            </form>
          ) : authConfigured ? (
            <Link
              href="/signin"
              className="ml-2 shrink-0 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 font-semibold text-surface hover:brightness-110"
            >
              Sign in
            </Link>
          ) : (
            <Link
              href="/signin"
              className="ml-2 shrink-0 whitespace-nowrap rounded-lg border border-dashed border-faint px-3 py-1.5 text-xs hover:text-ink"
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

/** The app logo - the same file the favicon uses, so there is one to change. */
function Logo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.svg"
      alt=""
      width={28}
      height={28}
      className="h-7 w-7 shrink-0 rounded-lg ring-1 ring-white/10"
    />
  );
}
