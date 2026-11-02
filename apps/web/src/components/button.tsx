'use client';

import { useFormStatus } from 'react-dom';

/**
 * The shared button. Inside a form it shows when that form is being saved, so
 * a slow save (a page's first action in dev mode compiles it) does not look
 * like a click that went nowhere.
 */
export function Button({
  children,
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const variants: Record<string, string> = {
    primary:
      'bg-accent font-semibold text-surface shadow-[0_6px_16px_-8px_var(--color-accent)] hover:brightness-110',
    ghost: 'border border-edge bg-raised/60 text-ink hover:border-faint hover:bg-raised',
    danger: 'bg-red-600/80 text-white hover:bg-red-600',
  };
  // While the form it submits is being saved: dimmed, and a second press does nothing.
  const { pending } = useFormStatus();
  return (
    <button
      {...props}
      disabled={props.disabled || pending}
      aria-busy={pending || undefined}
      className={`inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-wait ${variants[variant]} ${props.className ?? ''}`}
    >
      {children}
    </button>
  );
}
