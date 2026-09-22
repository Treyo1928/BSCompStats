import { parentPort } from 'node:worker_threads';
import {
  answerOpponentCard,
  computeMatchAdvice,
  type AnswerCardInput,
  type AnswerCardResult,
  type MatchAdviceInput,
  type MatchAdviceResult,
} from './match-advice.js';
import { chooseFitOptions } from '../stats/cv.js';
import type { FitOptions, Observation } from '../stats/model.js';

/**
 * Worker-thread entry point for the site's heavy arithmetic.
 *
 * The web server loads this file in a `worker_threads` Worker so that neither
 * the match simulation nor the model's cross-validation runs on the thread
 * serving requests. One job at a time, in the order received; the server keeps
 * a single thread and queues onto it.
 *
 * Deliberately not exported from the package index: importing it anywhere else
 * would attach a message handler to whatever thread did so.
 */

export type ThreadJob =
  | { id: number; kind: 'advice'; input: MatchAdviceInput }
  | { id: number; kind: 'answer'; input: AnswerCardInput }
  | { id: number; kind: 'chooseModel'; observations: Observation[] };

export type ThreadResult = MatchAdviceResult | AnswerCardResult | FitOptions;

parentPort?.on('message', (job: ThreadJob) => {
  try {
    const result: ThreadResult =
      job.kind === 'advice'
        ? computeMatchAdvice(job.input)
        : job.kind === 'answer'
          ? answerOpponentCard(job.input)
          : chooseFitOptions(job.observations).chosen;
    parentPort!.postMessage({ id: job.id, result });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) });
  }
});
