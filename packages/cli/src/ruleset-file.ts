import { parseRuleset } from '@kurenwimpel/core';
import type { ParseRulesetResult } from '@kurenwimpel/core';

import { UsageError } from './command.js';
import type { CliIo } from './command.js';

export interface LoadedRuleset {
  readonly path: string;
  readonly raw: unknown;
  readonly parsed: ParseRulesetResult;
}

/** Reads and parses a ruleset file. An unreadable file or invalid JSON is a {@link UsageError}. */
export async function loadRuleset(io: CliIo, path: string): Promise<LoadedRuleset> {
  const raw = parseJson(await readText(io, path), path);
  return { path, raw, parsed: parseRuleset(raw) };
}

/** The file's text, without the byte order mark some Windows editors write and `JSON.parse` rejects. */
export async function readText(io: CliIo, path: string): Promise<string> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${messageOf(error)}`, { cause: error });
  }
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/** Like {@link readText}, but `undefined` when the file does not exist. */
export async function readTextIfPresent(io: CliIo, path: string): Promise<string | undefined> {
  try {
    return await readText(io, path);
  } catch (error) {
    if (error instanceof UsageError && isMissing(error.cause)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${messageOf(error)}`);
  }
}

/** Parse issues go to stderr for commands whose stdout carries something else. */
export function warnAboutIssues(io: CliIo, loaded: LoadedRuleset): void {
  for (const issue of loaded.parsed.issues) {
    io.stderr(`warning: ${loaded.path}: ${issue.at}: ${issue.message}\n`);
  }
}

export function toJson(report: unknown): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
