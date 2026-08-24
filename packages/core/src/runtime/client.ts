import { readTargetingKey } from '../evaluation/conditions.js';
import { createSharedMemo, evaluateFlag } from '../evaluation/evaluate.js';
import type { EvaluationEnvironment } from '../evaluation/evaluate.js';
import type { AttributeValue, EvaluationContext } from '../model/context.js';
import type { FlagDefinition, FlagMetadata } from '../model/flag.js';
import type { FlagValue, JsonObject } from '../model/json.js';
import { EvaluationErrorCode, EvaluationReason } from '../model/result.js';
import type { EvaluationResult } from '../model/result.js';
import type { FlagProvider } from './provider.js';
import { EMPTY_SNAPSHOT } from './snapshot.js';
import type { FlagSnapshot } from './snapshot.js';

export interface ClientErrorInfo {
  readonly operation: 'load' | 'close' | 'impression';
  readonly provider: string;
}

/**
 * One evaluation, described for analytics: the exposure record an A/B test
 * joins against its outcome metric. Emitted synchronously through
 * `onImpression`; batching, sampling, and shipping are the consumer's job.
 */
export interface ImpressionEvent {
  readonly flagKey: string;
  readonly value: FlagValue | undefined;
  readonly variant: string | undefined;
  readonly reason: EvaluationReason;
  readonly ruleId?: string;
  readonly errorCode?: EvaluationErrorCode;
  readonly targetingKey?: string;
  /** The flag definition version, when the control plane stamps one. */
  readonly flagVersion?: number;
  readonly metadata?: FlagMetadata;
  /** Epoch millis when the evaluation happened. */
  readonly timestamp: number;
}

/** Knobs for {@link FeatureFlagClient.evaluateAll}. */
export interface BulkEvaluationOptions {
  /**
   * Emit an impression per flag. Off by default: a bulk fetch is not an
   * exposure, and counting it as one makes every experiment's exposed
   * population "everyone who loaded the page".
   */
  readonly impressions?: boolean;
}

export interface FeatureFlagClientOptions {
  readonly provider: FlagProvider;
  /**
   * Attributes merged under every per-call context — service name, region,
   * deployment stage. A per-call attribute wins on conflict; passing it as
   * `undefined` clears the default for that one call, and leaving it out
   * inherits the default.
   */
  readonly defaultContext?: EvaluationContext;
  /**
   * Called when a background refresh fails. Refresh errors are never thrown at
   * evaluation sites, because a stale snapshot beats a failed request.
   */
  readonly onError?: (error: Error, info: ClientErrorInfo) => void;
  /**
   * Called once per evaluation with the served outcome. This is the exposure
   * feed for experiment analysis; a throwing hook is reported through
   * `onError` and never fails the evaluation.
   */
  readonly onImpression?: (event: ImpressionEvent) => void;
}

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
  readonly #onImpression: ((event: ImpressionEvent) => void) | undefined;

  #snapshot: FlagSnapshot = EMPTY_SNAPSHOT;
  #environment: EvaluationEnvironment = environmentOf(EMPTY_SNAPSHOT);
  #ready = false;
  #loadInFlight: Promise<LoadOutcome> | undefined;

  constructor(options: FeatureFlagClientOptions) {
    this.#provider = options.provider;
    this.#defaultContext = { ...options.defaultContext };
    this.#defaultEntries = Object.entries(this.#defaultContext);
    this.#onError = options.onError;
    this.#onImpression = options.onImpression;
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
    if (outcome.status === 'failed') this.#report(outcome.error, 'load');

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
    this.#loadInFlight ??= this.#runLoad().finally(() => {
      this.#loadInFlight = undefined;
    });
    return this.#loadInFlight;
  }

  async #runLoad(): Promise<LoadOutcome> {
    const isFirstLoad = !this.#ready;

    try {
      const loaded = await this.#provider.load(isFirstLoad ? undefined : this.#snapshot);
      if (loaded === null) {
        // `null` means "unchanged since the snapshot I gave you". On the first
        // load nothing was handed over to be unchanged from, so there is no
        // snapshot to keep serving: coming up ready on an empty one would
        // answer every lookup FLAG_NOT_FOUND.
        return isFirstLoad
          ? { status: 'failed', error: this.#noFirstRuleset() }
          : { status: 'unchanged' };
      }

      this.#install(loaded);
      return { status: 'installed' };
    } catch (error) {
      // Carried as thrown rather than normalised here: `init` rethrows it at
      // its caller, and a service catching its own provider's error type
      // should still find it. `#report` does the normalising.
      return { status: 'failed', error };
    }
  }

  async close(): Promise<void> {
    try {
      await this.#provider.close?.();
    } catch (error) {
      this.#report(error, 'close');
    }
  }

  /** Replaces the snapshot directly. For tests and for pushed updates. */
  setSnapshot(snapshot: FlagSnapshot): void {
    this.#install(snapshot);
  }

  #install(snapshot: FlagSnapshot): void {
    this.#snapshot = snapshot;
    // Derived once per snapshot rather than per evaluation: the hot path should
    // not be allocating an environment object per lookup.
    this.#environment = environmentOf(snapshot);
    this.#ready = true;
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

  /**
   * The definition is handed over by the caller rather than looked up here:
   * every call site has just resolved it, and `evaluateAll` is already
   * iterating the definitions it would otherwise re-probe the map for, once per
   * flag in the ruleset.
   */
  #impress(
    result: EvaluationResult,
    context: EvaluationContext,
    flag: FlagDefinition | undefined,
  ): void {
    if (this.#onImpression === undefined) return;

    const flagVersion = flag?.version;
    // Resolved through the one identity rule rather than read off the context,
    // so the feed reports the key targeting actually used. Reading it directly
    // put whatever the caller passed on the event: a number in a field typed
    // string, breaking any downstream join on subject id; an empty string
    // alongside TARGETING_KEY_MISSING, counting an exposure for a subject that
    // was never bucketed; and, on a call with no per-call context, one
    // inherited from the default context's prototype and invisible to
    // targeting itself.
    const targetingKey = readTargetingKey(context);

    try {
      this.#onImpression({
        flagKey: result.key,
        value: result.value,
        variant: result.variant,
        reason: result.reason,
        ...(result.ruleId === undefined ? {} : { ruleId: result.ruleId }),
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        ...(targetingKey === undefined ? {} : { targetingKey }),
        ...(flagVersion === undefined ? {} : { flagVersion }),
        ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
        timestamp: Date.now(),
      });
    } catch (error) {
      this.#report(error, 'impression');
    }
  }

  /**
   * The context an evaluation actually runs against: the defaults, with
   * whatever the call said about them applied over the top.
   *
   * An explicit `null` reads as "no per-call context", exactly as omitting one
   * does. A JavaScript caller can pass it, the getters are documented never to
   * throw, and `evaluateFlag` already absorbs the same mistake one layer down
   * — this used to throw out of `Object.entries` before ever reaching it.
   */
  #mergeContext(context: EvaluationContext | null | undefined): EvaluationContext {
    if (context === undefined || context === null) return this.#defaultContext;

    // Null prototype: an own `__proto__` key in a JSON-parsed context must
    // land as plain data, never reach the Object.prototype setter and inject
    // inherited attributes into targeting.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const merged = Object.create(null) as Record<string, AttributeValue | undefined>;

    for (const [attribute, value] of this.#defaultEntries) {
      merged[attribute] = value;
    }

    // A default survives only where the call said nothing about the attribute.
    // Naming it with an explicit `undefined` is how a caller says "this request
    // has no stage", which it otherwise has no way to express — so one walk of
    // one list drives both the clearing and the overwriting. Deciding which
    // defaults to skip with `Object.hasOwn` while copying the values with
    // `Object.entries` let the two disagree: a non-enumerable own attribute —
    // an accessor on a class instance, a proxy-backed request object —
    // suppressed the default without supplying anything in its place, and
    // targeting saw neither.
    for (const [attribute, value] of Object.entries(context)) {
      if (value === undefined) delete merged[attribute];
      else merged[attribute] = value;
    }

    return merged;
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
 */
type LoadOutcome =
  | { readonly status: 'installed' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly error: unknown };

/** The lookups evaluation needs from a snapshot, in the shape it wants them. */
function environmentOf(snapshot: FlagSnapshot): EvaluationEnvironment {
  return {
    flags: snapshot.flags,
    segments: snapshot.segments,
    targetIndex: snapshot.targetIndex,
  };
}

/** An {@link EvaluationResult} whose value is guaranteed present, defaulted if need be. */
export type ResolvedEvaluation<T extends FlagValue> = Omit<EvaluationResult<T>, 'value'> & {
  readonly value: T;
};
