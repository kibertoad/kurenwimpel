import { evaluateFlag } from './evaluate.js';
import { EMPTY_SNAPSHOT, type FlagProvider, type FlagSnapshot } from './snapshot.js';
import type { EvaluationContext, EvaluationResult, FlagValue, JsonValue } from './types.js';
import { EvaluationErrorCode, EvaluationReason } from './types.js';

export interface ClientErrorInfo {
  readonly operation: 'load' | 'close';
  readonly provider: string;
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

  #snapshot: FlagSnapshot = EMPTY_SNAPSHOT;
  #ready = false;

  constructor(options: FeatureFlagClientOptions) {
    this.#provider = options.provider;
    this.#defaultContext = options.defaultContext ?? {};
    this.#onError = options.onError;
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
   * `onError` and keeps the previous snapshot.
   *
   * @returns whether a new snapshot was installed.
   */
  async refresh(): Promise<boolean> {
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

  getObject<T extends JsonValue>(key: string, defaultValue: T, context?: EvaluationContext): T {
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

  getObjectDetails<T extends JsonValue>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): ResolvedEvaluation<T> {
    return this.#typed(key, defaultValue, context, (value): value is T => {
      return typeof value === 'object' && value !== null;
    });
  }

  /** Raw evaluation, without the type check that the typed getters apply. */
  evaluate(key: string, context?: EvaluationContext): EvaluationResult {
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

    return evaluateFlag(flag, this.#mergeContext(context));
  }

  #typed<T extends FlagValue>(
    key: string,
    defaultValue: T,
    context: EvaluationContext | undefined,
    isExpectedType: (value: FlagValue) => value is T,
  ): ResolvedEvaluation<T> {
    const result = this.evaluate(key, context);

    if (result.value === undefined) {
      return { ...result, value: defaultValue };
    }

    if (!isExpectedType(result.value)) {
      return {
        key,
        value: defaultValue,
        variant: result.variant,
        reason: EvaluationReason.Error,
        errorCode: EvaluationErrorCode.TypeMismatch,
        errorMessage: `Flag "${key}" resolved to ${typeof result.value}, which is not the requested type`,
      };
    }

    return { ...result, value: result.value };
  }

  #mergeContext(context: EvaluationContext | undefined): EvaluationContext {
    if (context === undefined) return this.#defaultContext;

    const targetingKey = context.targetingKey ?? this.#defaultContext.targetingKey;
    const defaults = this.#defaultContext.attributes;

    const attributes =
      defaults === undefined ? context.attributes : { ...defaults, ...context.attributes };

    return {
      ...(targetingKey === undefined ? {} : { targetingKey }),
      ...(attributes === undefined ? {} : { attributes }),
    };
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
