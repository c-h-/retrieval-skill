import { existsSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { deleteVecForFile, insertVec } from './ann.mjs';
import { chunkDocument, extractContentTimestamp, extractMetadata, parseFrontmatter } from './chunker.mjs';
import { embedDocuments, embeddingToBlob, getModelId } from './embedder.mjs';
import { getMeta, openDb, setMeta } from './schema.mjs';
import { chunkHash, readFileContent, sha256, walkFiles } from './utils.mjs';

const DEFAULT_INDEX_DIR = join(homedir(), '.retrieval-skill', 'indexes');

/**
 * Get the database path for a named index.
 */
export function indexDbPath(name) {
  return join(DEFAULT_INDEX_DIR, `${name}.db`);
}

/**
 * Index a directory into a named index.
 * Supports incremental updates: only re-embeds changed files.
 */
export async function indexDirectory(directory, name, _opts = {}) {
  const dbPath = indexDbPath(name);
  const db = openDb(dbPath);
  const modelId = getModelId();

  // Store index metadata
  setMeta(db, 'index_name', name);
  setMeta(db, 'source_directory', directory);
  setMeta(db, 'model_id', modelId);

  // Prepare statements
  const getFile = db.prepare('SELECT id, content_hash, mtime_ms FROM files WHERE path = ?');
  const insertFile = db.prepare(`
    INSERT INTO files (path, content_hash, size, mtime_ms, indexed_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateFile = db.prepare(`
    UPDATE files SET content_hash = ?, size = ?, mtime_ms = ?, indexed_at = ?, metadata = ?
    WHERE id = ?
  `);
  const updateMtime = db.prepare('UPDATE files SET mtime_ms = ? WHERE id = ?');
  const deleteFileChunks = db.prepare('DELETE FROM chunks WHERE file_id = ?');
  // Contentless FTS5 tables don't support DELETE. Use the special 'delete' command.
  const getChunksForFile = db.prepare(
    'SELECT c.id, c.content, f.path FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.file_id = ?',
  );
  const deleteFtsEntry = db.prepare(
    "INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path) VALUES('delete', ?, ?, ?)",
  );
  const deleteFtsForFile = (fileId) => {
    const rows = getChunksForFile.all(fileId);
    for (const row of rows) {
      deleteFtsEntry.run(row.id, row.content, row.path);
    }
  };
  const insertChunk = db.prepare(`
    INSERT INTO chunks (file_id, chunk_index, content, embedding, content_hash, section_context, content_timestamp_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO chunks_fts (rowid, content, file_path) VALUES (?, ?, ?)
  `);
  const getChunkByHash = db.prepare('SELECT embedding FROM chunks WHERE content_hash = ? LIMIT 1');
  const allDbPaths = db.prepare('SELECT id, path FROM files').all();

  // Walk source directory
  console.error(`Scanning ${directory}...`);
  const files = await walkFiles(directory);
  console.error(`Found ${files.length} files.`);

  const filePathSet = new Set(files.map((f) => f.path));

  // Dead file pruning: delete DB entries for files no longer on disk
  let pruned = 0;
  for (const dbFile of allDbPaths) {
    if (!filePathSet.has(dbFile.path)) {
      deleteFtsForFile(dbFile.id);
      deleteVecForFile(db, dbFile.id);
      deleteFileChunks.run(dbFile.id);
      db.prepare('DELETE FROM files WHERE id = ?').run(dbFile.id);
      pruned++;
    }
  }
  if (pruned > 0) console.error(`Pruned ${pruned} deleted files from index.`);

  // Process files
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const existing = getFile.get(file.path);

    // Fast path: mtime unchanged → skip
    if (existing && Math.floor(existing.mtime_ms) === Math.floor(file.mtimeMs)) {
      skipped++;
      continue;
    }

    // Read content
    let content;
    try {
      content = await readFileContent(file.path);
    } catch (err) {
      console.error(`Error reading ${file.path}: ${err.message}`);
      errors++;
      continue;
    }

    const contentHash = sha256(content);

    // Content hash unchanged → just update mtime
    if (existing && existing.content_hash === contentHash) {
      updateMtime.run(file.mtimeMs, existing.id);
      skipped++;
      continue;
    }

    // Content changed → re-index
    const { frontmatter } = parseFrontmatter(content);
    const metadata = extractMetadata(frontmatter);
    const contentTimestampMs = extractContentTimestamp(frontmatter, file.mtimeMs);
    const chunks = chunkDocument(content);

    if (chunks.length === 0) {
      skipped++;
      continue;
    }

    // Check for cached embeddings (content-addressed)
    const embeddings = [];
    const toEmbed = [];
    const toEmbedIdx = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const hash = chunkHash(chunks[ci].content, modelId);
      const cached = getChunkByHash.get(hash);
      if (cached) {
        embeddings[ci] = cached.embedding;
      } else {
        toEmbed.push(chunks[ci].content);
        toEmbedIdx.push(ci);
      }
    }

    // Embed new chunks
    if (toEmbed.length > 0) {
      const newEmbeddings = await embedDocuments(toEmbed);
      for (let j = 0; j < toEmbedIdx.length; j++) {
        embeddings[toEmbedIdx[j]] = embeddingToBlob(newEmbeddings[j]);
      }
    }

    // Transactional update
    const now = new Date().toISOString();
    db.transaction(() => {
      let fileId;
      if (existing) {
        // Delete old chunks + FTS + vec entries
        deleteFtsForFile(existing.id);
        deleteVecForFile(db, existing.id);
        deleteFileChunks.run(existing.id);
        updateFile.run(contentHash, file.size, file.mtimeMs, now, metadata, existing.id);
        fileId = existing.id;
      } else {
        const result = insertFile.run(file.path, contentHash, file.size, file.mtimeMs, now, metadata);
        fileId = result.lastInsertRowid;
      }

      for (let ci = 0; ci < chunks.length; ci++) {
        const hash = chunkHash(chunks[ci].content, modelId);
        const embBlob = embeddings[ci] instanceof Buffer ? embeddings[ci] : embeddingToBlob(embeddings[ci]);
        const result = insertChunk.run(
          fileId,
          ci,
          chunks[ci].content,
          embBlob,
          hash,
          chunks[ci].sectionContext,
          contentTimestampMs,
        );
        insertFts.run(result.lastInsertRowid, chunks[ci].content, file.path);
        insertVec(db, result.lastInsertRowid, embBlob);
      }
    })();

    indexed++;
    if ((indexed + skipped) % 100 === 0 || indexed === 1) {
      console.error(`Progress: ${indexed} indexed, ${skipped} skipped / ${files.length} total`);
    }
  }

  // Store stats
  const totalChunks = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get().cnt;
  const totalFiles = db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt;
  setMeta(db, 'last_indexed_at', new Date().toISOString());
  setMeta(db, 'total_files', String(totalFiles));
  setMeta(db, 'total_chunks', String(totalChunks));

  db.close();

  const stats = { indexed, skipped, pruned, errors, totalFiles, totalChunks };
  console.error(`\nDone: ${indexed} indexed, ${skipped} skipped, ${pruned} pruned, ${errors} errors`);
  console.error(`Total: ${totalFiles} files, ${totalChunks} chunks in index "${name}"`);
  return stats;
}

/**
 * List all available indexes.
 */
export function listIndexes() {
  if (!existsSync(DEFAULT_INDEX_DIR)) return [];

  return readdirSync(DEFAULT_INDEX_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const name = f.replace('.db', '');
      const dbPath = join(DEFAULT_INDEX_DIR, f);
      try {
        const db = openDb(dbPath);
        const info = {
          name,
          sourceDirectory: getMeta(db, 'source_directory'),
          modelId: getMeta(db, 'model_id'),
          totalFiles: getMeta(db, 'total_files'),
          totalChunks: getMeta(db, 'total_chunks'),
          lastIndexedAt: getMeta(db, 'last_indexed_at'),
        };
        db.close();
        return info;
      } catch {
        return { name, error: 'Could not read index' };
      }
    });
}

/**
 * Get status for a named index.
 */
export function getIndexStatus(name) {
  const dbPath = indexDbPath(name);
  const db = openDb(dbPath);
  const info = {
    name,
    dbPath,
    sourceDirectory: getMeta(db, 'source_directory'),
    modelId: getMeta(db, 'model_id'),
    totalFiles: getMeta(db, 'total_files'),
    totalChunks: getMeta(db, 'total_chunks'),
    lastIndexedAt: getMeta(db, 'last_indexed_at'),
  };
  db.close();
  return info;
}

/**
 * Delete a named index.
 */
export function deleteIndex(name) {
  const dbPath = indexDbPath(name);
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (existsSync(p)) unlinkSync(p);
  }
}
