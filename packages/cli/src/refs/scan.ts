export interface FlagReference {
  readonly key: string;
  /** With `/` separators. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
}

export const SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
];

/**
 * A getter of the core client or of an OpenFeature client, called with a string
 * literal first argument. Type arguments are allowed; a template literal with a
 * placeholder is not a key this can read, and is skipped.
 */
const GETTER_CALL =
  /\b(?:get(?:Boolean|String|Number|Object)(?:Value|Details)?|evaluate)\s*(?:<[^<>()]*>)?\s*\(\s*(["'`])((?:(?!\1)[^\\\n$])+)\1/gu;

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Every flag key passed to a getter in one source file. */
export function findReferences(file: string, text: string): FlagReference[] {
  return [...text.matchAll(GETTER_CALL)].map((match) => ({
    key: match[2] ?? '',
    file: file.replaceAll('\\', '/'),
    line: text.slice(0, match.index).split('\n').length,
  }));
}
