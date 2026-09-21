'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

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
 * so it stays one thumb-height row however many pools there are.
 */
export function TournamentNav({ items }: { items: TournamentNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Tournament sections"
      className="-mx-3 mb-4 flex gap-1 overflow-x-auto border-b border-edge px-3 text-sm sm:mx-0 sm:mb-6 sm:px-0"
    >
      {items.map((item) => {
        const active = item.deep ? pathname.startsWith(item.href) : pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px inline-flex h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3 font-medium transition ${
              active ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
