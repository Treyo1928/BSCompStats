'use client';

import type { ReactNode } from 'react';

/** A submit button that asks first. For actions that cannot simply be retried. */
export function ConfirmButton({
  question,
  className,
  title,
  children,
}: {
  question: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      title={title}
      className={className}
      onClick={(event) => {
        if (!window.confirm(question)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
