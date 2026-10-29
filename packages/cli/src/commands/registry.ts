import type { Command } from '../command.js';
import { diffCommand } from './diff.js';
import { envsCommand } from './envs.js';
import { evalCommand } from './eval.js';
import { publishCommand } from './publish.js';
import { revisionsCommand, rollbackCommand } from './rollback.js';
import { scheduleCommand } from './schedule.js';
import { validateCommand } from './validate.js';

/** Every subcommand, in the order `--help` lists them. */
export const COMMANDS: readonly Command[] = [
  validateCommand,
  diffCommand,
  evalCommand,
  publishCommand,
  rollbackCommand,
  revisionsCommand,
  envsCommand,
  scheduleCommand,
];
