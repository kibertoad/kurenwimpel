import type { Command } from '../command.js';
import { diffCommand } from './diff.js';
import { envsCommand } from './envs.js';
import { evalCommand } from './eval.js';
import { lintCommand } from './lint.js';
import { publishCommand } from './publish.js';
import { refsCommand } from './refs.js';
import { revisionsCommand, rollbackCommand } from './rollback.js';
import { validateCommand } from './validate.js';

/** Every subcommand, in the order `--help` lists them. */
export const COMMANDS: readonly Command[] = [
  validateCommand,
  diffCommand,
  evalCommand,
  lintCommand,
  refsCommand,
  publishCommand,
  rollbackCommand,
  revisionsCommand,
  envsCommand,
];
