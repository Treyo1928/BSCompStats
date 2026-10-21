import { Button, inputClass } from './ui';

/**
 * A "Rename" toggle for a page header: closed it is one small link, open it is
 * the name field and a save button. Works without JavaScript.
 */
export function RenameForm({
  action,
  idName,
  id,
  name,
  label = 'Rename',
}: {
  action: (formData: FormData) => Promise<void>;
  /** The form field carrying the id, e.g. "poolId". */
  idName: string;
  id: string;
  name: string;
  label?: string;
}) {
  return (
    <details className="group relative">
      <summary className="inline-flex h-9 cursor-pointer list-none items-center rounded-lg px-2 text-xs text-muted transition hover:bg-raised hover:text-ink">
        {label}
      </summary>
      <form
        action={action}
        className="absolute right-0 z-20 mt-1 flex w-[min(22rem,calc(100vw-2rem))] items-center gap-2 rounded-lg border border-edge bg-panel p-2 shadow-xl"
      >
        <input type="hidden" name={idName} value={id} />
        <input
          name="name"
          defaultValue={name}
          aria-label="New name"
          maxLength={80}
          required
          className={`${inputClass} min-w-0 flex-1`}
        />
        <Button type="submit">Save</Button>
      </form>
    </details>
  );
}
