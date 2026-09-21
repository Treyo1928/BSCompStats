import { redirect } from 'next/navigation';

/**
 * Send a plain <form action> back where it came from with a message to show.
 *
 * A thrown error would do for a bug, but these are ordinary mistakes - a name
 * already taken, a pool too small - and production builds replace a thrown
 * message with a generic crash page. The message travels in the URL so the
 * page can render it with no client code.
 */
export function failBack(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}
