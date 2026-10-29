import type { FeatureFlagClient, JsonObject } from '@kurenwimpel/core';
import { OpenFeatureEventEmitter, ProviderEvents } from '@openfeature/server-sdk';
import type {
  EvaluationContext,
  JsonValue,
  Provider,
  ResolutionDetails,
} from '@openfeature/server-sdk';

import { toEngineContext } from './context.js';
import { toResolutionDetails } from './resolution.js';

/** Stands in for a non-object default, so a served default can be told apart from a flag value. */
const NO_OBJECT: JsonObject = Object.freeze({});

/**
 * An OpenFeature server provider backed by a {@link FeatureFlagClient}.
 *
 * Emits `ConfigurationChanged` when the client installs a new snapshot,
 * `Stale` when a refresh fails while serving, and `Ready` once a refresh
 * succeeds again.
 */
export class KurenwimpelProvider implements Provider {
  readonly metadata = { name: 'kurenwimpel' } as const;
  readonly runsOn = 'server';
  readonly events = new OpenFeatureEventEmitter();

  readonly #client: FeatureFlagClient;
  #unsubscribe: (() => void) | undefined;
  #serving = false;
  #stale = false;

  constructor(client: FeatureFlagClient) {
    this.#client = client;
  }

  /** Loads the client unless it is already ready, as a started `PollingFlagClient` is. */
  async initialize(): Promise<void> {
    this.#unsubscribe ??= this.#client.subscribe({
      onSnapshotChange: (snapshot, previous) => {
        if (previous === undefined) return;
        this.events.emit(
          ProviderEvents.ConfigurationChanged,
          snapshot.version === undefined ? {} : { metadata: { version: snapshot.version } },
        );
      },
      onLoad: () => {
        this.#loadFinished();
      },
    });
    if (!this.#client.ready) await this.#client.init();
    this.#serving = true;
  }

  async onClose(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#serving = false;
    await this.#client.close();
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    const result = this.#client.getBooleanDetails(flagKey, defaultValue, toEngineContext(context));
    return Promise.resolve(toResolutionDetails(result, result.value));
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<string>> {
    const result = this.#client.getStringDetails(flagKey, defaultValue, toEngineContext(context));
    return Promise.resolve(toResolutionDetails(result, result.value));
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<number>> {
    const result = this.#client.getNumberDetails(flagKey, defaultValue, toEngineContext(context));
    return Promise.resolve(toResolutionDetails(result, result.value));
  }

  /** Engine flag values are never arrays or primitives at the top level, so only an object default is handed to the client. */
  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const fallback = isObject(defaultValue) ? (defaultValue as JsonObject) : NO_OBJECT;
    const result = this.#client.getObjectDetails(flagKey, fallback, toEngineContext(context));
    // T is the caller's claim about the flag's shape; nothing at runtime can check it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const value = result.value === NO_OBJECT ? defaultValue : (result.value as unknown as T);
    return Promise.resolve(toResolutionDetails(result, value));
  }

  #loadFinished(): void {
    if (!this.#serving) return;
    const stale = this.#client.status().consecutiveFailures > 0;
    if (stale === this.#stale) return;
    this.#stale = stale;
    if (stale) {
      this.events.emit(ProviderEvents.Stale, {
        message: 'Flag refresh failed; serving the previous snapshot',
      });
    } else {
      this.events.emit(ProviderEvents.Ready);
    }
  }
}

function isObject(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
