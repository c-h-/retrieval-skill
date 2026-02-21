#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'path';
import { buildAnnIndex } from './ann.mjs';
import { deleteIndex, getIndexStatus, indexDbPath, indexDirectory, listIndexes } from './index.mjs';
import { openDb } from './schema.mjs';
import { formatResults, formatResultsJson, search } from './search.mjs';
import { indexPdfVision } from './vision-index.mjs';

const program = new Command();

program.name('retrieve').description('Generic retrieval system: incremental indexing + hybrid search').version('1.0.0');

program
  .command('index <directory>')
  .description('Index a directory of markdown files')
  .option('--name <name>', 'Index name (defaults to directory basename)')
  .action(async (directory, opts) => {
    const dir = resolve(directory);
    const name = opts.name || dir.split('/').pop();
    console.error(`Indexing "${dir}" as "${name}"...`);
    const stats = await indexDirectory(dir, name);
    console.log(JSON.stringify(stats, null, 2));
  });

program
  .command('index-vision <pdf>')
  .description('Index a PDF with vision embeddings (ColQwen2.5)')
  .option('--name <name>', 'Index name (defaults to PDF basename)')
  .option('--batch-size <n>', 'Pages per embedding batch', '2')
  .option('--extract-text', 'Also extract text for FTS search (OCR fallback for image-only pages)')
  .action(async (pdf, opts) => {
    const pdfPath = resolve(pdf);
    const name =
      opts.name ||
      pdfPath
        .split('/')
        .pop()
        .replace(/\.pdf$/i, '');
    const batchSize = parseInt(opts.batchSize, 10);
    const extractText = !!opts.extractText;
    console.error(`Indexing "${pdfPath}" as "${name}" with vision embeddings...`);
    const stats = await indexPdfVision(pdfPath, name, { batchSize, extractText });
    console.log(JSON.stringify(stats, null, 2));
  });

program
  .command('search <query>')
  .description('Search across one or more indexes')
  .requiredOption('--index <names>', 'Comma-separated index names')
  .option('--top-k <n>', 'Number of results', '10')
  .option('--threshold <score>', 'Minimum score threshold', '0')
  .option('--mode <mode>', 'Search mode: text (default), vision, hybrid', 'text')
  .option('--recency-weight <n>', 'Recency weight (0 to disable, default 0.15)', '0.15')
  .option('--half-life <days>', 'Recency half-life in days (default 90)', '90')
  .option(
    '--filter <key=value>',
    'Metadata filter as key=value (repeatable)',
    (val, acc) => {
      acc.push(val);
      return acc;
    },
    [],
  )
  .option('--json', 'Output as JSON')
  .action(async (query, opts) => {
    const indexNames = opts.index.split(',').map((s) => s.trim());
    const topK = parseInt(opts.topK, 10);
    const threshold = parseFloat(opts.threshold);
    const mode = opts.mode;
    const recencyWeight = parseFloat(opts.recencyWeight);
    const halfLifeDays = parseFloat(opts.halfLife);

    // Parse metadata filters from --filter key=value pairs
    let filters = null;
    if (opts.filter && opts.filter.length > 0) {
      filters = {};
      for (const f of opts.filter) {
        const eqIdx = f.indexOf('=');
        if (eqIdx === -1) {
          console.error(`Warning: Invalid filter "${f}" — expected key=value format`);
          continue;
        }
        filters[f.slice(0, eqIdx)] = f.slice(eqIdx + 1);
      }
    }

    const results = await search(query, indexNames, { topK, threshold, mode, recencyWeight, halfLifeDays, filters });

    if (opts.json) {
      console.log(formatResultsJson(results));
    } else {
      console.log(formatResults(results, query));
    }
  });

program
  .command('list')
  .description('List all available indexes')
  .action(() => {
    const indexes = listIndexes();
    if (indexes.length === 0) {
      console.log('No indexes found.');
      return;
    }
    for (const idx of indexes) {
      if (idx.error) {
        console.log(`  ${idx.name}: ${idx.error}`);
      } else {
        console.log(`  ${idx.name}`);
        console.log(`    Source: ${idx.sourceDirectory}`);
        console.log(`    Files: ${idx.totalFiles}, Chunks: ${idx.totalChunks}`);
        console.log(`    Model: ${idx.modelId}`);
        console.log(`    Last indexed: ${idx.lastIndexedAt}`);
      }
    }
  });

program
  .command('status <name>')
  .description('Show index status')
  .action((name) => {
    try {
      const info = getIndexStatus(name);
      console.log(JSON.stringify(info, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('build-ann <name>')
  .description('Build approximate nearest neighbor index for faster vector search')
  .option('--min-chunks <n>', 'Minimum chunks required to build (default 1000)', '1000')
  .action((name, opts) => {
    const dbPath = indexDbPath(name);
    const db = openDb(dbPath);
    const result = buildAnnIndex(db, { minChunks: parseInt(opts.minChunks, 10) });
    db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('delete <name>')
  .description('Delete an index')
  .action((name) => {
    deleteIndex(name);
    console.log(`Index "${name}" deleted.`);
  });

program.parse();
