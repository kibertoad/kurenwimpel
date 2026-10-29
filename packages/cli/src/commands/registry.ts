import type { Command } from '../command.js';
import { diffCommand } from './diff.js';
import { evalCommand } from './eval.js';
import { validateCommand } from './validate.js';

/** Every subcommand, in the order `--help` lists them. */
export const COMMANDS: readonly Command[] = [validateCommand, diffCommand, evalCommand];
