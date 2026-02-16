import { createHash } from 'crypto';
import { readdir, stat, readFile } from 'fs/promises';
import { join, extname } from 'path';

const INDEXED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

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
  return sha256(content + '\0' + modelId);
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
      // Skip metadata and hidden directories
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      await _walk(fullPath, results);
    } else if (entry.isFile() && INDEXED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
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
