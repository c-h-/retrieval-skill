// Type definitions for retrieval-skill
// Project: https://github.com/c-h-/retrieval-skill

// --- schema.mjs ---
import type Database from "better-sqlite3";

export function openDb(
  dbPath: string,
  opts?: { vision?: boolean }
): Database.Database;
export function getMeta(db: Database.Database, key: string): string | null;
export function setMeta(db: Database.Database, key: string, value: string): void;

// --- embedder.mjs ---
export function loadModel(opts?: Record<string, unknown>): Promise<boolean>;
export function embedDocuments(texts: string[]): Promise<Float32Array[]>;
export function embedQuery(query: string): Promise<Float32Array>;
export function embeddingToBlob(embedding: Float32Array): Buffer;
export function blobToEmbedding(blob: Buffer): Float32Array;
export function getModelId(): string;
export function getEmbeddingDim(): number;

// --- chunker.mjs ---
export interface Frontmatter {
  [key: string]: unknown;
}

export interface ParseResult {
  frontmatter: Frontmatter | null;
  body: string;
}

export interface Chunk {
  content: string;
  sectionContext: string | null;
}

export function parseFrontmatter(content: string): ParseResult;
export function extractTitle(
  frontmatter: Frontmatter | null,
  body: string
): string | null;
export function splitSections(
  body: string
): Array<{ heading: string | null; content: string }>;
export function chunkDocument(rawContent: string): Chunk[];
export function extractContentTimestamp(
  frontmatter: Frontmatter | null,
  mtimeMs?: number | null
): number | null;
export function extractMetadata(frontmatter: Frontmatter | null): string | null;

// --- utils.mjs ---
export function sha256(content: string | Buffer): string;
export function chunkHash(content: string, modelId: string): string;
export function walkFiles(
  dir: string
): Promise<Array<{ path: string; size: number; mtimeMs: number }>>;
export function readFileContent(filePath: string): Promise<string>;

// --- index.mjs ---
export function indexDbPath(name: string): string;

export interface IndexStats {
  indexed: number;
  skipped: number;
  pruned: number;
  errors: number;
  totalFiles: number;
  totalChunks: number;
}

export function indexDirectory(
  directory: string,
  name: string,
  opts?: Record<string, unknown>
): Promise<IndexStats>;

export interface IndexInfo {
  name: string;
  sourceDirectory?: string | null;
  modelId?: string | null;
  totalFiles?: string | null;
  totalChunks?: string | null;
  lastIndexedAt?: string | null;
  error?: string;
}

export function listIndexes(): IndexInfo[];

export interface IndexStatus {
  name: string;
  dbPath: string;
  sourceDirectory: string | null;
  modelId: string | null;
  totalFiles: string | null;
  totalChunks: string | null;
  lastIndexedAt: string | null;
}

export function getIndexStatus(name: string): IndexStatus;
export function deleteIndex(name: string): void;

// --- vision-index.mjs ---
export function visionIndexDbPath(name: string): string;

export interface VisionIndexStats {
  indexed: number;
  skipped: number;
  errors: number;
  totalPages: number;
  totalVectors: number;
  ocrPages: number;
}

export function indexPdfVision(
  pdfPath: string,
  name: string,
  opts?: {
    batchSize?: number;
    extractText?: boolean;
  }
): Promise<VisionIndexStats>;

// --- search.mjs ---
export function recencyBoost(
  contentTimestampMs: number | null,
  halfLifeDays?: number
): number;

export function relativeAge(timestampMs: number | null): string | null;

export function matchesFilters(
  metadataJson: string | null,
  filters: Record<string, string> | null
): boolean;

export interface SearchResult {
  content: string;
  score: number;
  semanticScore?: number;
  rrfScore?: number;
  vecScore: number;
  ftsScore: number;
  filePath: string;
  relativePath: string;
  sectionContext: string | null;
  metadata: Record<string, unknown> | null;
  indexName: string;
  chunkIndex?: number;
  contentTimestampMs?: number | null;
  resultType: "text" | "vision";
  pageNumber?: number;
  sourcePath?: string;
}

export interface SearchOptions {
  topK?: number;
  threshold?: number;
  mode?: "text" | "vision" | "hybrid";
  recencyWeight?: number;
  halfLifeDays?: number;
  filters?: Record<string, string> | null;
}

export function search(
  query: string,
  indexNames: string[],
  opts?: SearchOptions
): Promise<SearchResult[]>;

export function formatResults(results: SearchResult[], query: string): string;
export function formatResultsJson(results: SearchResult[]): string;

// --- ann.mjs ---
export function kmeans(
  vectors: Float32Array[],
  k: number,
  maxIter?: number
): Float32Array[];

export interface AnnBuildResult {
  built: boolean;
  reason?: string;
  numClusters: number;
  numChunks?: number;
}

export function buildAnnIndex(
  db: Database.Database,
  opts?: { minChunks?: number }
): AnnBuildResult;

export function hasAnnIndex(db: Database.Database): boolean;

export function annCandidates(
  db: Database.Database,
  queryEmbedding: Float32Array,
  nprobe?: number
): Set<number>;

// --- search/maxsim.mjs ---
export function maxSimScore(
  queryVectors: Float32Array[],
  pageVectors: Float32Array[]
): number;

export function searchVisionIndex(
  db: Database.Database,
  queryVectors: Float32Array[],
  topK?: number
): Array<{
  pageImageId: number;
  documentId: string;
  pageNumber: number;
  score: number;
  sourcePath: string;
}>;

// --- adapters/adapter.mjs ---
export interface EmbeddingAdapter {
  name: string;
  type: "text" | "vision";
  init(): Promise<void>;
  embedQuery(query: string): Promise<Float32Array | Float32Array[]>;
  embedDocuments?(texts: string[]): Promise<Float32Array[]>;
  embedImages?(imagePaths: string[]): Promise<Float32Array[][]>;
  embeddingDim(): number;
  modelId(): string;
  dispose(): Promise<void>;
}

export function validateAdapter(adapter: EmbeddingAdapter): boolean;
export function registerAdapter(adapter: EmbeddingAdapter): void;
export function getAdapter(name: string): EmbeddingAdapter;
export function getAdaptersByType(type: "text" | "vision"): EmbeddingAdapter[];
export function listAdapters(): Array<{
  name: string;
  type: string;
  modelId: string;
}>;
export function clearRegistry(): void;

// --- adapters/text-adapter.mjs ---
export function createTextAdapter(): EmbeddingAdapter & {
  embeddingToBlob(embedding: Float32Array): Buffer;
  blobToEmbedding(blob: Buffer): Float32Array;
};

// --- adapters/vision-adapter.mjs ---
export function createVisionAdapter(opts?: {
  backend?: string;
}): EmbeddingAdapter & {
  extractPages(
    pdfPath: string,
    outputDir: string
  ): Promise<{ paths: string[]; page_count: number }>;
  extractText(
    pdfPath: string
  ): Promise<{
    pages: Array<{ page_number: number; text: string; method: string }>;
    has_tesseract: boolean;
  }>;
  embedImagesWithMeta(
    imagePaths: string[]
  ): Promise<{
    embeddings: Float32Array[][];
    num_vectors: number[];
  }>;
  embeddingToBlob(embedding: Float32Array): Buffer;
  blobToEmbedding(blob: Buffer): Float32Array;
};

// --- vision/bridge.mjs ---
export class VisionBridge {
  constructor(opts?: { backend?: string });
  backend: string;
  ready: boolean;
  start(): Promise<{
    ready: boolean;
    model: string;
    device: string;
  }>;
  health(): Promise<{
    status: string;
    model: string;
    device: string;
    dtype: string;
  }>;
  embedImages(
    paths: string[]
  ): Promise<{
    embeddings: Float32Array[][];
    num_vectors: number[];
  }>;
  embedQuery(text: string): Promise<Float32Array[]>;
  embedQueries(texts: string[]): Promise<Float32Array[][]>;
  extractPages(
    pdfPath: string,
    outputDir: string
  ): Promise<{ paths: string[]; page_count: number }>;
  extractText(
    pdfPath: string
  ): Promise<{
    pages: Array<{ page_number: number; text: string; method: string }>;
    has_tesseract: boolean;
  }>;
  stop(): Promise<void>;
}

export function getBridge(opts?: { backend?: string }): VisionBridge;
