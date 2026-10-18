import type { InterleafDatabase } from '../db/database';
import {
  ONBOARDING_STATUSES,
  resolveResumeStage,
  shouldAutoOpenOnboarding,
  type OnboardingLaunchVerdict,
  type OnboardingStatus,
} from '@shared/constants/onboarding';
import type { OnboardingLaunchState } from '@shared/types/onboarding';
import type { Logger } from '../logging/logger';
import { isPortableRecord, parsePortableJson, type PortableMember, type PortableValue } from '@shared/models/portable';

/**
 * Guided onboarding — the launch verdict, computed once and latched.
 *
 * Every fact that separates a genuinely new user from an existing one is
 * destroyed by ordinary startup, so all of them are read in a single pass
 * before the first mutation:
 *
 * - `schema_migrations` tells whether the database predates this launch, but
 *   `applyMigrations` creates that table when it is missing.
 * - Migration 2 (`seed_default_settings`) inserts the `settings` row itself on
 *   every fresh database, so after migrations the row exists no matter who the
 *   user is. Its presence is only meaningful *before* that migration runs.
 * - `SettingsRepository.get()` substitutes defaults for a missing row and the
 *   schema materializes a missing `onboarding` section, so the stored JSON has
 *   to be read directly, and before the first repository read.
 *
 * Capture therefore happens with the database open and no migration applied;
 * the verdict derived from it is frozen and held for the process lifetime.
 * Nothing here inspects a credential, a probe, a filesystem path or document
 * content: the result is booleans and one enum member.
 */

/**
 * Everything observable about the store before startup changes it.
 *
 * Read in one pass immediately after `InterleafDatabase.open` and before
 * `runMigrations`. On a truly fresh file none of these tables exist yet, which
 * is precisely the signal.
 */
export type OnboardingLaunchEvidence = {
  /** A migration history existed already, so the database predates this launch. */
  readonly priorMigrationHistory: boolean;
  /** A `settings` row existed before migration 2 could seed one. */
  readonly settingsRowPresent: boolean;
  readonly onboardingSectionPresent: boolean;
  readonly status: OnboardingStatus | null;
  readonly lastStageAcknowledged: string | null;
  /** Rows only a user's actions create. */
  readonly userRowsPresent: boolean;
};

const ABSENT_EVIDENCE: OnboardingLaunchEvidence = {
  priorMigrationHistory: false,
  settingsRowPresent: false,
  onboardingSectionPresent: false,
  status: null,
  lastStageAcknowledged: null,
  userRowsPresent: false,
};

/**
 * Tables whose rows only exist because a user did something.
 *
 * `agent_profiles` is deliberately absent as a whole: startup detection writes
 * a row for every built-in profile on every launch, so its presence proves
 * nothing. Only the custom profiles a user configured are counted, which is why
 * that one table is queried with a predicate.
 */
const USER_ROW_TABLES = ['documents', 'folders', 'annotations', 'chat_sessions', 'agent_sessions'] as const;

/**
 * Reads the pre-startup evidence.
 *
 * Any failure is treated as "an existing install" rather than throwing: a
 * launch must not fail because onboarding could not classify it, and the safe
 * direction is to stay quiet rather than auto-open over somebody's library.
 */
export function captureOnboardingLaunchEvidence(
  database: InterleafDatabase,
  log: Logger
): OnboardingLaunchEvidence {
  try {
    return {
      priorMigrationHistory:
        tableExists(database, 'schema_migrations')
        && hasAnyRow(database, 'SELECT 1 FROM schema_migrations LIMIT 1'),
      userRowsPresent: hasUserRows(database),
      ...readStoredOnboardingSection(database),
    };
  } catch (error) {
    log.warn('onboarding could not read launch evidence', {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    // Unknown is not new. Never auto-open over a store we failed to read.
    return { ...ABSENT_EVIDENCE, priorMigrationHistory: true };
  }
}

/** The stored `onboarding` section as it exists on disk, before any defaulting. */
type StoredOnboardingSection = Pick<
  OnboardingLaunchEvidence,
  'settingsRowPresent' | 'onboardingSectionPresent' | 'status' | 'lastStageAcknowledged'
>;

/**
 * Derives the launch verdict from captured evidence.
 *
 * Pure by design: once the evidence is in hand the answer cannot depend on how
 * far startup has since progressed.
 */
export function deriveOnboardingLaunchState(evidence: OnboardingLaunchEvidence): OnboardingLaunchState {
  const priorInstallEvidence =
    evidence.priorMigrationHistory || evidence.settingsRowPresent || evidence.userRowsPresent;
  const verdict = resolveVerdict(evidence, priorInstallEvidence);
  return Object.freeze({
    verdict,
    shouldAutoOpen: shouldAutoOpenOnboarding(verdict),
    resumeStage: verdict === 'resume' ? resolveResumeStage(evidence.lastStageAcknowledged) : 'welcome',
    settingsRowPresent: evidence.settingsRowPresent,
    onboardingSectionPresent: evidence.onboardingSectionPresent,
    priorInstallEvidence,
  });
}

/**
 * The §5.1 verdict table.
 *
 * Saved progress wins over install classification wherever the user has
 * actually interacted with the flow: someone who left it half-finished on an
 * upgraded install still gets to resume, and someone who dismissed it on a
 * fresh install is not shown it again.
 */
function resolveVerdict(
  evidence: OnboardingLaunchEvidence,
  priorInstallEvidence: boolean
): OnboardingLaunchVerdict {
  if (evidence.status === 'in-progress') return 'resume';
  if (evidence.status === 'finish-later') return 'suppressed';
  if (evidence.status === 'dismissed' || evidence.status === 'completed') return 'done';
  if (evidence.status === 'not-started') return 'not-started';
  // No usable stored section. The install itself decides.
  return priorInstallEvidence ? 'upgraded-install' : 'new-install';
}

/**
 * The launch verdict as it stands for a page load happening now.
 *
 * The latched verdict is the only thing that can tell a genuinely new install
 * from an existing one, because the evidence for that is destroyed by startup.
 * A renderer reload is not a new launch, though: replaying the latched verdict
 * reopens a wizard the user has already left in this same process. A decision
 * the user has since persisted therefore governs the reload, while
 * `not-started` — the value every fresh install is seeded with, and the value
 * still stored during a first launch nobody has acted on — leaves the launch
 * classification exactly as it was latched.
 */
export function reconcileOnboardingLaunchState(
  latched: OnboardingLaunchState,
  stored: { readonly status: OnboardingStatus; readonly lastStageAcknowledged: string | null }
): OnboardingLaunchState {
  if (stored.status === 'not-started') return latched;
  const verdict = resolveVerdict(
    { ...ABSENT_EVIDENCE, status: stored.status },
    latched.priorInstallEvidence
  );
  return Object.freeze({
    ...latched,
    verdict,
    shouldAutoOpen: shouldAutoOpenOnboarding(verdict),
    resumeStage: verdict === 'resume' ? resolveResumeStage(stored.lastStageAcknowledged) : 'welcome',
  });
}

function readStoredOnboardingSection(database: InterleafDatabase): StoredOnboardingSection {
  const absent: StoredOnboardingSection = {
    settingsRowPresent: false, onboardingSectionPresent: false, status: null, lastStageAcknowledged: null,
  };
  if (!tableExists(database, 'settings')) return absent;
  const row = database.raw
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .get('app') as { value_json?: PortableValue } | undefined;
  if (row === undefined) return absent;
  if (typeof row.value_json !== 'string') {
    // A corrupt row is still a row: the install is not new.
    return { ...absent, settingsRowPresent: true };
  }
  let document: PortableValue;
  try {
    document = parsePortableJson(row.value_json);
  } catch {
    return { ...absent, settingsRowPresent: true };
  }
  const section = isPortableRecord(document) ? document.onboarding : undefined;
  if (!isPortableRecord(section)) return { ...absent, settingsRowPresent: true };
  const status = section.status;
  const lastStage = section.lastStageAcknowledged;
  return {
    settingsRowPresent: true,
    onboardingSectionPresent: true,
    status: isOnboardingStatus(status) ? status : null,
    lastStageAcknowledged: typeof lastStage === 'string' ? lastStage : null,
  };
}

/**
 * Bounded existence checks only — a `LIMIT 1` probe per table, never a count of
 * a user's library. An empty library on its own proves nothing either way, so
 * absence here never classifies an install as fresh by itself.
 */
function hasUserRows(database: InterleafDatabase): boolean {
  for (const table of USER_ROW_TABLES) {
    if (tableExists(database, table) && hasAnyRow(database, `SELECT 1 FROM ${table} LIMIT 1`)) return true;
  }
  return tableExists(database, 'agent_profiles')
    && hasAnyRow(database, 'SELECT 1 FROM agent_profiles WHERE is_custom = 1 LIMIT 1');
}

function tableExists(database: InterleafDatabase, table: string): boolean {
  const row = database.raw
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present?: PortableValue } | undefined;
  return row !== undefined;
}

/** `sql` is a fixed `LIMIT 1` existence probe written in this module; it never
 * carries a caller-supplied value. */
function hasAnyRow(database: InterleafDatabase, sql: string): boolean {
  return database.raw.prepare(sql).get() !== undefined;
}

function isOnboardingStatus(value: PortableMember): value is OnboardingStatus {
  return typeof value === 'string' && (ONBOARDING_STATUSES as readonly string[]).includes(value);
}

/**
 * Holds one verdict for the process lifetime.
 *
 * The verdict is fixed at construction and never replaced: nothing may
 * reclassify the launch after settings have been initialized, which is exactly
 * the failure this whole module exists to prevent.
 */
export class OnboardingLaunchStateLatch {
  readonly #state: OnboardingLaunchState;

  constructor(state: OnboardingLaunchState) {
    this.#state = state;
  }

  get(): OnboardingLaunchState {
    return this.#state;
  }
}
