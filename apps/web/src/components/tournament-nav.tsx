'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export interface TournamentNavItem {
  href: string;
  label: string;
  /** Matches any path beneath it, not only the path itself. */
  deep?: boolean;
}

/**
 * The sections of one tournament, as a strip under the site header.
 *
 * On a phone this is the navigation: it scrolls sideways rather than wrapping,
 * so it stays one thumb-height row. Map pools sit behind one "Map pools" entry
 * that opens a second strip - a tournament can have any number of them, and
 * listed inline they pushed Teams and Player stats off the side of the screen.
 */
export function TournamentNav({
  before,
  pools,
  after,
}: {
  before: TournamentNavItem[];
  pools: TournamentNavItem[];
  after: TournamentNavItem[];
}) {
  const pathname = usePathname();
  const onPool = pools.some((pool) => pathname === pool.href);
  // Open by itself while a pool is on screen; otherwise as the viewer left it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  useEffect(() => setToggled(null), [pathname]);
  const open = toggled ?? onPool;

  const tab = (active: boolean) =>
    `-mb-px inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 font-medium transition ${
      active ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
    }`;
  const section = (item: TournamentNavItem) => {
    const active = item.deep ? pathname.startsWith(item.href) : pathname === item.href;
    return (
      <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} className={tab(active)}>
        {item.label}
      </Link>
    );
  };

  return (
    <div className="mb-4 sm:mb-6">
      <nav
        aria-label="Tournament sections"
        className="-mx-3 flex gap-1 overflow-x-auto border-b border-edge px-3 text-sm sm:mx-0 sm:px-0"
      >
        {before.map(section)}
        {pools.length > 0 && (
          <button
            type="button"
            onClick={() => setToggled(!open)}
            aria-expanded={open}
            aria-controls="tournament-pools"
            className={tab(onPool)}
          >
            Map pools
            <span aria-hidden className={`text-[9px] transition-transform ${open ? 'rotate-90' : ''}`}>
              ▶
            </span>
          </button>
        )}
        {after.map(section)}
      </nav>

      {open && (
        <nav
          id="tournament-pools"
          aria-label="Map pools"
          className="-mx-3 flex gap-1.5 overflow-x-auto border-b border-edge bg-panel/50 px-3 py-2 text-xs sm:mx-0 sm:px-2"
        >
          {pools.map((pool) => {
            const active = pathname === pool.href;
            return (
              <Link
                key={pool.href}
                href={pool.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-3 font-medium transition ${
                  active
                    ? 'border-accent bg-accent/15 text-ink'
                    : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
                }`}
              >
                {pool.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
