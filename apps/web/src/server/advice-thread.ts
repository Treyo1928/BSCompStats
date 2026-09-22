import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import {
  answerOpponentCard,
  computeMatchAdvice,
  type AnswerCardInput,
  type AnswerCardResult,
  type MatchAdviceInput,
  type MatchAdviceResult,
} from '@bscs/core/optimize';
import { chooseFitOptions, type FitOptions, type Observation } from '@bscs/core/stats';

/**
 * Runs match advice on a worker thread.
 *
 * Node serves every request from one thread, and working out lineups is
 * seconds of solid CPU. Done inline, that is seconds in which nobody's page
 * loads, nobody's pick registers and every live stream stalls. On a thread of
 * its own the site stays responsive, and the advice simply arrives a little
 * later.
 *
 * One thread, kept alive, fed from a queue: two simulations at once would only
 * fight over the same cores, and spawning per job would pay Node's start-up
 * cost every time.
 *
 * The script is the compiled core package, copied into the image beside the
 * server (see docker/web.Dockerfile). Where it is missing - `next dev`, or an
 * image built without it - the work is done inline instead, so advice still
 * appears; it just blocks like it used to.
 */

const SCRIPT =
  process.env.ADVICE_THREAD_PATH ?? '/app/advice/core/optimize/advice-thread.js';

interface Waiting {
  resolve: (result: never) => void;
  reject: (reason: Error) => void;
}

const state = globalThis as unknown as {
  adviceWorker?: Worker | null;
  adviceWaiting?: Map<number, Waiting>;
  adviceNextId?: number;
};

function getWorker(): Worker | null {
  if (state.adviceWorker !== undefined) return state.adviceWorker;
  if (!existsSync(SCRIPT)) {
    console.warn(`[advice] ${SCRIPT} not found - computing match advice on the main thread`);
    return (state.adviceWorker = null);
  }

  const waiting = (state.adviceWaiting ??= new Map());
  const worker = new Worker(SCRIPT);

  worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
    const job = waiting.get(message.id);
    if (!job) return;
    waiting.delete(message.id);
    if (message.result) job.resolve(message.result as never);
    else job.reject(new Error(message.error ?? 'advice thread failed'));
  });

  // A crashed thread takes its queue with it; fail those jobs and start afresh
  // on the next request rather than leaving pages waiting for ever.
  const fail = (reason: Error) => {
    for (const job of waiting.values()) job.reject(reason);
    waiting.clear();
    if (state.adviceWorker === worker) state.adviceWorker = undefined;
  };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`advice thread exited with code ${code}`)));
  // Never the reason the server cannot shut down.
  worker.unref();

  return (state.adviceWorker = worker);
}

function submit<T>(job: Record<string, unknown>, inline: () => T): Promise<T> {
  const worker = getWorker();
  if (!worker) return Promise.resolve().then(inline);

  const id = (state.adviceNextId = (state.adviceNextId ?? 0) + 1);
  return new Promise<T>((resolve, reject) => {
    state.adviceWaiting!.set(id, { resolve: resolve as Waiting['resolve'], reject });
    worker.postMessage({ id, ...job });
  });
}

export function runMatchAdvice(input: MatchAdviceInput): Promise<MatchAdviceResult> {
  return submit({ kind: 'advice', input }, () => computeMatchAdvice(input));
}

/** The best card against one particular opponent card. */
export function runAnswerCard(input: AnswerCardInput): Promise<AnswerCardResult> {
  return submit({ kind: 'answer', input }, () => answerOpponentCard(input));
}

/** Cross-validate which model complexity fits these scores best. */
export function runChooseModel(observations: Observation[]): Promise<FitOptions> {
  return submit({ kind: 'chooseModel', observations }, () => chooseFitOptions(observations).chosen);
}
