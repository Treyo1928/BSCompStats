/**
 * "Are you sure?", asked in the page.
 *
 * Not `window.confirm`: a browser stops showing those once a visitor ticks
 * "don't let this page ask again" (and some never show them at all), and then
 * it answers "no" on its own, so every button behind one goes dead with nothing
 * to see. This one is part of the page and cannot be switched off.
 *
 * Resolves true only for the confirming button; Escape, Cancel and a click
 * outside are all "no". Browser only.
 */
export function ask(question: string, confirmLabel = 'Yes'): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'm-auto w-[min(26rem,92vw)] rounded-xl border border-edge bg-panel p-5 text-ink backdrop:bg-black/75';
    dialog.setAttribute('aria-label', question);

    const text = document.createElement('p');
    text.className = 'whitespace-pre-line text-sm';
    text.textContent = question;

    const row = document.createElement('div');
    row.className = 'mt-5 flex justify-end gap-2';
    const button = (label: string, className: string, answer: boolean) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = `inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium transition ${className}`;
      b.addEventListener('click', () => dialog.close(answer ? 'yes' : ''));
      row.append(b);
      return b;
    };
    const cancel = button('Cancel', 'border-edge text-muted hover:border-faint hover:text-ink', false);
    button(confirmLabel, 'border-red-400/50 bg-red-600/20 text-lose hover:bg-red-600/30', true);

    dialog.append(text, row);
    dialog.addEventListener('click', (e) => e.target === dialog && dialog.close(''));
    dialog.addEventListener('close', () => {
      const yes = dialog.returnValue === 'yes';
      dialog.remove();
      resolve(yes);
    });
    document.body.append(dialog);
    dialog.showModal();
    // Enter must not carry out something that cannot be undone
    cancel.focus();
  });
}

/**
 * For a submit button's onClick: hold the submit, ask, and send the form only
 * on a yes. The confirming button carries the clicked button's own words.
 */
export function askThenSubmit(event: { preventDefault(): void; currentTarget: HTMLButtonElement }, question: string): void {
  event.preventDefault();
  const button = event.currentTarget;
  void ask(question, button.textContent?.trim() || 'Yes').then((yes) => {
    if (yes) button.form?.requestSubmit(button);
  });
}
