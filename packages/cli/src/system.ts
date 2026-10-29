import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** The `CliIo.git` the `kurenwimpel` binary uses. */
export function runGit(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`git ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`));
    });
  });
}

/** The `CliIo.listFiles` the `kurenwimpel` binary uses. */
export async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry): Promise<string[]> => {
      const path = join(directory, entry.name);
      if (entry.isFile()) return Promise.resolve([path]);
      if (entry.isDirectory() && !isSkipped(entry.name)) return listFiles(path);
      return Promise.resolve([]);
    }),
  );
  return nested.flat().toSorted();
}

function isSkipped(name: string): boolean {
  return name === 'node_modules' || name.startsWith('.');
}
