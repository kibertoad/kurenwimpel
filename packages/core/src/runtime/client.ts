import { evaluateFlag } from '../evaluation/evaluate.js';
import type { EvaluationEnvironment } from '../evaluation/evaluate.js';
import type { AttributeValue, EvaluationContext } from '../model/context.js';
import type { FlagMetadata } from '../model/flag.js';
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

export interface FeatureFlagClientOptions {
  readonly provider: FlagProvider;
  /**
   * Attributes merged under every per-call context — service name, region,
   * deployment stage. Per-call values win on conflict.
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
 * fall back to the caller's default for anything they cannot resolve.
 */
export class FeatureFlagClient {
  readonly #provider: FlagProvider;
  readonly #defaultContext: EvaluationContext;
  readonly #onError: ((error: Error, info: ClientErrorInfo) => void) | undefined;
  readonly #onImpression: ((event: ImpressionEvent) => void) | undefined;

  #snapshot: FlagSnapshot = EMPTY_SNAPSHOT;
  #ready = false;
  #refreshInFlight: Promise<boolean> | undefined;

  constructor(options: FeatureFlagClientOptions) {
    this.#provider = options.provider;
    this.#defaultContext = options.defaultContext ?? {};
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
   */
  async init(): Promise<void> {
    const loaded = await this.#provider.load();
    if (loaded !== null) this.#snapshot = loaded;
    this.#ready = true;
  }

  /**
   * Reloads in the background. Swallows provider errors — reports them through
   * `onError` and keeps the previous snapshot. Overlapping calls share one
   * load: a slow older request must never resolve after a newer one and roll
   * the snapshot back.
   *
   * @returns whether a new snapshot was installed.
   */
  refresh(): Promise<boolean> {
    this.#refreshInFlight ??= this.#runRefresh().finally(() => {
      this.#refreshInFlight = undefined;
    });
    return this.#refreshInFlight;
  }

  async #runRefresh(): Promise<boolean> {
    try {
      const loaded = await this.#provider.load(this.#ready ? this.#snapshot : undefined);
      if (loaded === null) return false;

      this.#snapshot = loaded;
      this.#ready = true;
      return true;
    } catch (error) {
      this.#report(error, 'load');
      return false;
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
    this.#snapshot = snapshot;
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
    const result = this.#resolve(key, merged);
    this.#impress(result, merged);
    return result;
  }

  /**
   * Evaluates every flag in the snapshot against one context — the shape the
   * OFREP bulk route serves. Returns an empty array before the first load.
   */
  evaluateAll(context?: EvaluationContext): EvaluationResult[] {
    const merged = this.#mergeContext(context);
    const environment = this.#environment();
    const results: EvaluationResult[] = [];

    for (const flag of this.#snapshot.flags.values()) {
      const result = evaluateFlag(flag, merged, environment);
      this.#impress(result, merged);
      results.push(result);
    }

    return results;
  }

  #resolve(key: string, context: EvaluationContext): EvaluationResult {
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

    const flag = this.#snapshot.flags.get(key);

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

    return evaluateFlag(flag, context, this.#environment());
  }

  #environment(): EvaluationEnvironment {
    return { flags: this.#snapshot.flags, segments: this.#snapshot.segments };
  }

  #typed<T extends FlagValue>(
    key: string,
    defaultValue: T,
    context: EvaluationContext | undefined,
    isExpectedType: (value: FlagValue) => value is T,
  ): ResolvedEvaluation<T> {
    const merged = this.#mergeContext(context);
    const result = this.#resolve(key, merged);
    const final = this.#coerce(result, defaultValue, isExpectedType);
    this.#impress(final, merged);
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

  #impress(result: EvaluationResult, context: EvaluationContext): void {
    if (this.#onImpression === undefined) return;

    const flagVersion = this.#snapshot.flags.get(result.key)?.version;

    try {
      this.#onImpression({
        flagKey: result.key,
        value: result.value,
        variant: result.variant,
        reason: result.reason,
        ...(result.ruleId === undefined ? {} : { ruleId: result.ruleId }),
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        ...(context.targetingKey === undefined ? {} : { targetingKey: context.targetingKey }),
        ...(flagVersion === undefined ? {} : { flagVersion }),
        ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
        timestamp: Date.now(),
      });
    } catch (error) {
      this.#report(error, 'impression');
    }
  }

  #mergeContext(context: EvaluationContext | undefined): EvaluationContext {
    if (context === undefined) return this.#defaultContext;

    // Null prototype: an own `__proto__` key in a JSON-parsed context must
    // land as plain data, never reach the Object.prototype setter and inject
    // inherited attributes into targeting.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const merged = Object.create(null) as Record<string, AttributeValue | undefined>;
    for (const [attribute, value] of Object.entries(this.#defaultContext)) {
      merged[attribute] = value;
    }
    for (const [attribute, value] of Object.entries(context)) {
      if (value !== undefined) merged[attribute] = value;
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

/** An {@link EvaluationResult} whose value is guaranteed present, defaulted if need be. */
export type ResolvedEvaluation<T extends FlagValue> = Omit<EvaluationResult<T>, 'value'> & {
  readonly value: T;
};
