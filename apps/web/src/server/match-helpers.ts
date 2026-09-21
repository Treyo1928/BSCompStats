/**
 * Re-exports the pure match logic from @bscs/core under one import, so route
 * handlers and pages do not each reach into four different module paths.
 */
export {
  parseFormat,
  matchFormatSchema,
  MSU_DUOS_FORMAT,
  FORMAT_PRESETS,
  expectedMapCount,
  requiredPoolSize,
  currentStep,
  prepareAction,
  resolveMapPlan,
  isComplete,
  remainingMapIds,
  assertPoolIsBigEnough,
  PickBanError,
  validateLineups,
  legalAdditions,
  duoKey,
  can,
  assertCan,
  canOverrideViolations,
  isStaff,
  isCaptainOf,
  ForbiddenError,
  type MatchFormat,
  type MatchRules,
  type PickBanContext,
  type PendingStep,
  type AppliedAction,
  type MatchMapPlan,
  type LineupInput,
  type ValidationResult,
  type Violation,
  type Actor,
  type TournamentRole,
} from '@bscs/core/match';

export {
  difficultyLabel as difficultyLabelFor,
  displayDifficulty,
} from '@bscs/core/beatleader';
