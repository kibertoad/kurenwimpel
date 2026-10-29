import type { TargetConfig } from '../config/types.js';
import { fileTarget } from './file-target.js';
import { kvTarget } from './kv-target.js';
import { objectTarget } from './object-target.js';
import type { PublishTarget, TargetDeps } from './target.js';

/**
 * Builds the target a config entry describes. Reads credentials from
 * `deps.env` up front, so a missing variable fails before anything is written.
 */
export function createTarget(config: TargetConfig, deps: TargetDeps): PublishTarget {
  switch (config.type) {
    case 'kv':
      return kvTarget(config, deps);
    case 'file':
      return fileTarget(config);
    case 's3':
    case 'r2':
      return objectTarget(config, deps);
  }
}
