import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const SCHEMA_VERSION = 4; // v4: added content_timestamp_ms to chunks

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  section_context TEXT,
  content_timestamp_ms INTEGER,
  UNIQUE(file_id, chunk_index)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, file_path, content='', content_rowid='id'
);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
`;

// Vision tables — additive migration, never touches text tables
const VISION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS page_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  image_hash TEXT NOT NULL,
  adapter_name TEXT NOT NULL,
  num_vectors INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE(document_id, page_number)
);

CREATE TABLE IF NOT EXISTS page_vectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_image_id INTEGER NOT NULL REFERENCES page_images(id) ON DELETE CASCADE,
  vector_index INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  UNIQUE(page_image_id, vector_index)
);

CREATE INDEX IF NOT EXISTS idx_page_images_doc ON page_images(document_id);
CREATE INDEX IF NOT EXISTS idx_page_images_hash ON page_images(image_hash);
CREATE INDEX IF NOT EXISTS idx_page_vectors_page ON page_vectors(page_image_id);
`;

/**
 * Open or create an index database at the given path.
 * Returns a better-sqlite3 Database instance with schema initialized.
 */
export function openDb(dbPath, { vision = false } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Run vision schema migration (additive, safe to run on any DB)
  if (vision) {
    db.exec(VISION_SCHEMA_SQL);
  }

  // Set schema version if not present, or upgrade
  const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!existing) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  } else {
    const ver = parseInt(existing.value, 10);
    if (vision && ver < 3) {
      db.exec(VISION_SCHEMA_SQL);
    }
    if (ver < 4) {
      // v4 migration: add content_timestamp_ms column to chunks
      const cols = db.pragma('table_info(chunks)').map((c) => c.name);
      if (!cols.includes('content_timestamp_ms')) {
        db.exec('ALTER TABLE chunks ADD COLUMN content_timestamp_ms INTEGER');
      }
    }
    if (ver < SCHEMA_VERSION) {
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
    }
  }

  return db;
}

/**
 * Get a metadata value from the meta table.
 */
export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Set a metadata value in the meta table.
 */
export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}
