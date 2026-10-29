import { createSharedMemo, evaluateFlag } from '../evaluation/evaluate.js';
import type { EvaluationEnvironment } from '../evaluation/evaluate.js';
import type { AttributeValue, EvaluationContext } from '../model/context.js';
import type { FlagDefinition } from '../model/flag.js';
import type { FlagValue, JsonObject } from '../model/json.js';
import { EvaluationErrorCode, EvaluationReason } from '../model/result.js';
import type { EvaluationResult } from '../model/result.js';
import type {
  BulkEvaluationOptions,
  ClientErrorInfo,
  FeatureFlagClientOptions,
} from './client-options.js';
import { impressionOf, mergeContext } from './impressions.js';
import type { FlagProvider, ProviderLoadContext } from './provider.js';
import { completeSnapshot, EMPTY_SNAPSHOT, environmentOf } from './snapshot.js';
import type { FlagSnapshot } from './snapshot.js';
import { LoadHealth } from './status.js';
import type { ClientStatus } from './status.js';

/**
 * The evaluation entry point.
 *
 * Loading is async and explicit; evaluation is synchronous and total. Once
 * {@link FeatureFlagClient.init} has resolved, `getBoolean` and friends never
 * throw, never await, and never do I/O — they read the in-memory snapshot and
 * fall back to the caller's default for anything they cannot resolve. The one
 * exception is {@link FeatureFlagClient.evaluateAll}, which has nowhere to put
 * a per-flag error and so refuses to answer at all before the first load.
 */
export class FeatureFlagClient {
  readonly #provider: FlagProvider;
  /**
   * The default context, copied rather than aliased.
   *
   * {@link FeatureFlagClient.#defaultEntries} is walked once, at construction;
   * a caller that went on mutating the object it passed would have the two
   * merge paths disagree — a lookup with no per-call context reading the live
   * object, a lookup with one walking the entries captured here — and the same
   * flag answering two ways in one process depending only on whether the call
   * site passed a context.
   */
  readonly #defaultContext: EvaluationContext;
  /** The default context's entries, walked once here instead of per evaluation. */
  readonly #defaultEntries: readonly (readonly [string, AttributeValue | undefined])[];
  readonly #onError: ((error: Error, info: ClientErrorInfo) => void) | undefined;
  readonly #onImpression: FeatureFlagClientOptions['onImpression'];
  readonly #onSnapshotChange: FeatureFlagClientOptions['onSnapshotChange'];
  readonly #metrics: FeatureFlagClientOptions['metrics'];
  readonly #health = new LoadHealth();

  #snapshot: FlagSnapshot = EMPTY_SNAPSHOT;
  #environment: EvaluationEnvironment = environmentOf(EMPTY_SNAPSHOT);
  #ready = false;
  #loadInFlight: Promise<LoadOutcome> | undefined;
  readonly #loadContext: ProviderLoadContext = {
    reportError: this.#report.bind(this),
    reportParseIssues: (issues) => {
      this.#health.addParseIssues(issues.length);
    },
  };

  constructor(options: FeatureFlagClientOptions) {
    this.#provider = options.provider;
    this.#defaultContext = { ...options.defaultContext };
    this.#defaultEntries = Object.entries(this.#defaultContext);
    this.#onError = options.onError;
    this.#onImpression = options.onImpression;
    this.#onSnapshotChange = options.onSnapshotChange;
    this.#metrics = options.metrics;
  }

  /** Freshness and failure counters, for readiness probes and staleness alerts. */
  status(): ClientStatus {
    return this.#health.status(this.#snapshot, this.#ready);
  }

  /** True once a snapshot has been loaded at least once. */
  get ready(): boolean {
    return this.#ready;
  }

  get snapshot(): FlagSnapshot {
    return this.#snapshot;
  }

  get providerName(): string {
    return this.#provider.name;
  }

  /**
   * Performs the first load.
   *
   * Unlike {@link FeatureFlagClient.refresh}, this rethrows: a service that
   * cannot read its flags at startup should fail to start rather than serve
   * every request on fallback values.
   *
   * Shares the in-flight load with {@link FeatureFlagClient.refresh} rather
   * than opening one of its own. Going straight to the provider here left the
   * ordering guarantee holding only among refreshes: a `refresh()` and an
   * `init()` in the same tick ran two loads, and whichever resolved second
   * installed its snapshot — so the slower, older one could roll the client
   * backward. `PollingFlagClient.start()` awaits `init()` with nothing
   * stopping a caller from refreshing alongside it.
   */
  async init(): Promise<void> {
    const outcome = await this.#load();
    if (outcome.status === 'failed') throw outcome.error;
  }

  /**
   * The provider answered "unchanged" when it had been handed nothing to be
   * unchanged from. Fatal at startup; reported, not thrown, when a background
   * refresh is what happens to perform the first load.
   */
  #noFirstRuleset(): Error {
    return new Error(
      `Provider "${this.#provider.name}" reported no change on the first load, so there is no ruleset to serve`,
    );
  }

  /**
   * Reloads in the background. Swallows provider errors — reports them through
   * `onError` and keeps the previous snapshot. Overlapping calls share one
   * load: a slow older request must never resolve after a newer one and roll
   * the snapshot back.
   *
   * @returns whether a new snapshot was installed.
   */
  async refresh(): Promise<boolean> {
    const outcome = await this.#load();

    // Reported rather than thrown — including the "no ruleset at all" answer a
    // `refresh` before `init` can reach, which `init` refuses to start on.
    // Returning a bare `false` for that one would read as "nothing to
    // install", when in fact nothing has ever been installed and every lookup
    // is about to be answered PROVIDER_NOT_READY.
    //
    // Once per load, not once per caller. Overlapping refreshes join a single
    // trip to the provider, and reporting on the way out fanned that one
    // failure into an `onError` call each: a `PollingFlagClient` whose control
    // plane is slower than its poll interval raised an alert per queued poll
    // for one failed fetch, and any failure counter behind the hook counted
    // the same outage several times over.
    if (outcome.status === 'failed' && !outcome.reported) {
      outcome.reported = true;
      this.#report(outcome.error, 'load');
    }

    return outcome.status === 'installed';
  }

  /**
   * The one path to the provider, shared by everything that wants a load.
   *
   * Whoever asks while a load is in flight joins it instead of starting a
   * second one, which is what keeps two loads from resolving out of order and
   * installing the older snapshot. `init` and `refresh` differ only in what
   * they do with the outcome.
   */
  #load(): Promise<LoadOutcome> {
    this.#loadInFlight ??= this.#runLoad()
      .then((outcome) => {
        this.#health.finishLoad(outcome.status, this.#snapshot.origin);
        return outcome;
      })
      .finally(() => {
        this.#loadInFlight = undefined;
      });
    return this.#loadInFlight;
  }

  async #runLoad(): Promise<LoadOutcome> {
    const isFirstLoad = !this.#ready;
    this.#health.startLoad();

    try {
      const previous = isFirstLoad ? undefined : this.#snapshot;
      const loaded = await this.#provider.load(previous, this.#loadContext);
      if (loaded === null) {
        // `null` means "unchanged since the snapshot I gave you". On the first
        // load nothing was handed over to be unchanged from, so there is no
        // snapshot to keep serving: coming up ready on an empty one would
        // answer every lookup FLAG_NOT_FOUND.
        return isFirstLoad
          ? { status: 'failed', error: this.#noFirstRuleset(), reported: false }
          : { status: 'unchanged' };
      }

      this.#install(loaded);
      return { status: 'installed' };
    } catch (error) {
      // Carried as thrown rather than normalised here: `init` rethrows it at
      // its caller, and a service catching its own provider's error type
      // should still find it. `#report` does the normalising.
      return { status: 'failed', error, reported: false };
    }
  }

  async close(): Promise<void> {
    try {
      await this.#provider.close?.();
    } catch (error) {
      this.#report(error, 'close');
    }
  }

  /**
   * Replaces the snapshot directly. For tests and for pushed updates. A live
   * snapshot counts as a successful load in {@link FeatureFlagClient.status}.
   */
  setSnapshot(snapshot: FlagSnapshot): void {
    this.#install(snapshot);
    if (this.#snapshot.origin === 'live') this.#health.markSuccess();
  }

  #install(snapshot: FlagSnapshot): void {
    const previous = this.#ready ? this.#snapshot : undefined;
    // Completed on the way in, so that the snapshot this client serves — and
    // hands back through `snapshot` — carries every lookup evaluation reads,
    // whoever built it. See {@link completeSnapshot}.
    this.#snapshot = completeSnapshot(snapshot);
    // Derived once per snapshot rather than per evaluation: the hot path should
    // not be allocating an environment object per lookup.
    this.#environment = environmentOf(this.#snapshot);
    this.#ready = true;

    try {
      this.#onSnapshotChange?.(this.#snapshot, previous);
    } catch (error) {
      this.#report(error, 'snapshotChange');
    }
  }

  getBoolean(key: string, defaultValue: boolean, context?: EvaluationContext): boolean {
    return this.getBooleanDetails(key, defaultValue, context).value;
  }

  getString(key: string, defaultValue: string, context?: EvaluationContext): string {
    return this.getStringDetails(key, defaultValue, context).value;
  }

  getNumber(key: string, defaultValue: number, context?: EvaluationContext): number {
    return this.getNumberDetails(key, defaultValue, context).value;
  }

  getObject<T extends JsonObject>(key: string, defaultValue: T, context?: EvaluationContext): T {
    return this.getObjectDetails(key, defaultValue, context).value;
  }

  getBooleanDetails(
    key: string,
    defaultValue: boolean,
    context?: EvaluationContext,
  ): ResolvedEvaluation<boolean> {
    return this.#typed(key, defaultValue, context, (value): value is boolean => {
      return typeof value === 'boolean';
    });
  }

  getStringDetails(
    key: string,
    defaultValue: string,
    context?: EvaluationContext,
  ): ResolvedEvaluation<string> {
    return this.#typed(key, defaultValue, context, (value): value is string => {
      return typeof value === 'string';
    });
  }

  getNumberDetails(
    key: string,
    defaultValue: number,
    context?: EvaluationContext,
  ): ResolvedEvaluation<number> {
    return this.#typed(key, defaultValue, context, (value): value is number => {
      return typeof value === 'number' && Number.isFinite(value);
    });
  }

  getObjectDetails<T extends JsonObject>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): ResolvedEvaluation<T> {
    return this.#typed(key, defaultValue, context, (value): value is T => {
      // Hand-built definitions can bypass the parser, so the null and array
      // exclusions are re-checked at runtime rather than trusted to the types.
      return typeof value === 'object' && (value as unknown) !== null && !Array.isArray(value);
    });
  }

  /** Raw evaluation, without the type check that the typed getters apply. */
  evaluate(key: string, context?: EvaluationContext): EvaluationResult {
    const merged = this.#mergeContext(context);
    const flag = this.#snapshot.flags.get(key);
    const result = this.#resolve(key, flag, merged);
    this.#count(result);
    this.#impress(result, merged, flag);
    return result;
  }

  /**
   * Evaluates every flag in the snapshot against one context — the shape the
   * OFREP bulk route serves. The typed getters are the exposure points, so no
   * impressions are emitted unless {@link BulkEvaluationOptions.impressions}
   * asks for them.
   *
   * @throws before the first load. A bulk response has no per-flag slot to
   * report `PROVIDER_NOT_READY` in, and an empty array cannot be told apart
   * from a healthy empty ruleset — a caller that answered 200 with it would
   * have every downstream SDK silently serving its own defaults. Check
   * {@link FeatureFlagClient.ready} to avoid the throw.
   */
  evaluateAll(context?: EvaluationContext, options?: BulkEvaluationOptions): EvaluationResult[] {
    if (!this.#ready) {
      throw new Error(`Client for provider "${this.#provider.name}" has not loaded flags yet`);
    }

    const merged = this.#mergeContext(context);
    const results: EvaluationResult[] = [];

    // One memo for the whole response. Every flag still walks its own chain,
    // but a prerequisite shared by many of them — a kill switch above a whole
    // feature tree — is evaluated once rather than once per dependent.
    const memo = createSharedMemo();

    for (const flag of this.#snapshot.flags.values()) {
      const result = evaluateFlag(flag, merged, this.#environment, memo);
      this.#count(result);
      if (options?.impressions === true) this.#impress(result, merged, flag);
      results.push(result);
    }

    return results;
  }

  /** The definition is passed in, not looked up again: see {@link FeatureFlagClient.#impress}. */
  #resolve(
    key: string,
    flag: FlagDefinition | undefined,
    context: EvaluationContext,
  ): EvaluationResult {
    if (!this.#ready) {
      return {
        key,
        value: undefined,
        variant: undefined,
        reason: EvaluationReason.Error,
        errorCode: EvaluationErrorCode.ProviderNotReady,
        errorMessage: `Client for provider "${this.#provider.name}" has not loaded flags yet`,
      };
    }

    if (flag === undefined) {
      return {
        key,
        value: undefined,
        variant: undefined,
        reason: EvaluationReason.Error,
        errorCode: EvaluationErrorCode.FlagNotFound,
        errorMessage: `Unknown flag "${key}"`,
      };
    }

    return evaluateFlag(flag, context, this.#environment);
  }

  #typed<T extends FlagValue>(
    key: string,
    defaultValue: T,
    context: EvaluationContext | undefined,
    isExpectedType: (value: FlagValue) => value is T,
  ): ResolvedEvaluation<T> {
    const merged = this.#mergeContext(context);
    const flag = this.#snapshot.flags.get(key);
    const result = this.#resolve(key, flag, merged);
    const final = this.#coerce(result, defaultValue, isExpectedType);
    this.#count(final);
    this.#impress(final, merged, flag);
    return final;
  }

  #coerce<T extends FlagValue>(
    result: EvaluationResult,
    defaultValue: T,
    isExpectedType: (value: FlagValue) => value is T,
  ): ResolvedEvaluation<T> {
    if (result.value === undefined) {
      return { ...result, value: defaultValue };
    }

    if (!isExpectedType(result.value)) {
      // Spread first: metadata, ruleId, and the rest must survive the
      // mismatch, or the impression cannot be joined to its experiment.
      return {
        ...result,
        value: defaultValue,
        reason: EvaluationReason.Error,
        errorCode: EvaluationErrorCode.TypeMismatch,
        errorMessage: `Flag "${result.key}" resolved to ${typeof result.value}, which is not the requested type`,
      };
    }

    return { ...result, value: result.value };
  }

  #count(result: EvaluationResult): void {
    if (this.#metrics === undefined) return;
    try {
      this.#metrics.record(result.key, result.variant, result.reason, result.errorCode);
    } catch (error) {
      this.#report(error, 'metrics');
    }
  }

  #impress(
    result: EvaluationResult,
    context: EvaluationContext,
    flag: FlagDefinition | undefined,
  ): void {
    if (this.#onImpression === undefined) return;
    try {
      this.#onImpression(impressionOf(result, context, flag));
    } catch (error) {
      this.#report(error, 'impression');
    }
  }

  #mergeContext(context: EvaluationContext | null | undefined): EvaluationContext {
    return mergeContext(this.#defaultContext, this.#defaultEntries, context);
  }

  #report(error: unknown, operation: ClientErrorInfo['operation']): void {
    this.#onError?.(error instanceof Error ? error : new Error(String(error)), {
      operation,
      provider: this.#provider.name,
    });
  }
}

/**
 * What one trip to the provider came back with. "Unchanged" and "failed" are
 * kept apart because the first is a healthy answer and the second is not.
 *
 * `reported` is the one mutable field, and it is what makes "once per load"
 * mean once: every caller that joined the load is handed this same object, so
 * whichever of them reports the failure first records that it has been said.
 */
type LoadOutcome =
  | { readonly status: 'installed' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly error: unknown; reported: boolean };

/** An {@link EvaluationResult} whose value is guaranteed present, defaulted if need be. */
export type ResolvedEvaluation<T extends FlagValue> = Omit<EvaluationResult<T>, 'value'> & {
  readonly value: T;
};
