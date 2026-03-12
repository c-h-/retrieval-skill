import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { extname, join } from 'path';

const INDEXED_EXTENSIONS = new Set([
  // Docs / prose
  '.md',
  '.markdown',
  '.txt',
  '.mdx',
  // TypeScript / JavaScript
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  // Python
  '.py',
  // Config
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.env.example',
  // Infrastructure
  '.tf',
  '.hcl',
  '.sh',
  '.bash',
  // Web
  '.css',
  '.scss',
  '.html',
  // Database / API
  '.prisma',
  '.graphql',
  '.gql',
  '.sql',
  // Other
  '.xml',
  '.csv',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
]);

/** Extensionless filenames that should be indexed. */
const INDEXED_FILENAMES = new Set([
  'Dockerfile',
  'Makefile',
  '.gitignore',
  '.dockerignore',
  '.eslintrc',
  '.prettierrc',
]);

/** Lock files to always skip. */
const SKIPPED_FILENAMES = new Set([
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
]);

/** Directories to skip during walk (in addition to _ and . prefixed dirs). */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '__generated__',
  'generated',
  'coverage',
  '.turbo',
  '.yarn',
  'venv',
  '.venv',
]);

/**
 * SHA-256 hash of a string, returned as hex.
 */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Content-addressed chunk hash: SHA-256(chunk_content + model_id).
 * Same content embedded with the same model can reuse the embedding.
 */
export function chunkHash(content, modelId) {
  return sha256(`${content}\0${modelId}`);
}

/**
 * Recursively walk a directory, yielding file info for indexable files.
 * Skips _meta directories and non-markdown files.
 * Returns array of { path, size, mtimeMs }.
 */
export async function walkFiles(dir) {
  const results = [];
  await _walk(dir, results);
  return results;
}

async function _walk(dir, results) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      await _walk(fullPath, results);
    } else if (entry.isFile()) {
      const name = entry.name;
      if (SKIPPED_FILENAMES.has(name)) continue;
      const isIndexable = INDEXED_EXTENSIONS.has(extname(name).toLowerCase()) || INDEXED_FILENAMES.has(name);
      if (!isIndexable) continue;
      try {
        const s = await stat(fullPath);
        results.push({ path: fullPath, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        // Skip files we can't stat
      }
    }
  }
}

/**
 * Read file content as UTF-8 string.
 */
export async function readFileContent(filePath) {
  return readFile(filePath, 'utf-8');
}
