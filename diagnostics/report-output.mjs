/** Generated reports stay separate from committed scripts and historical baselines. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const reportDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../test-results/backend');
export async function writeReport(filename, report) {
  if (!/^[a-z0-9-]+\.json$/.test(filename)) throw new Error('Invalid diagnostic report filename.');
  await mkdir(reportDirectory, { recursive: true });
  const destination = resolve(reportDirectory, filename);
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  return `test-results/backend/${filename}`;
}
