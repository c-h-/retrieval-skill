/**
 * VisionBridge — Node.js ↔ Python subprocess communication for ColQwen2.5.
 *
 * Spawns the Python vision server as a child process,
 * communicates via JSON-RPC over stdin/stdout.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, 'server.py');

// Find the venv python
const VENV_DIR = join(__dirname, 'venv');
const VENV_PYTHON = join(VENV_DIR, 'bin', 'python3');

export class VisionBridge {
  constructor() {
    this.process = null;
    this.readline = null;
    this.requestId = 0;
    this.pending = new Map(); // id → { resolve, reject }
    this.ready = false;
    this._readyPromise = null;
  }

  /**
   * Start the Python vision server subprocess.
   * Resolves when the server signals readiness (model loaded).
   */
  async start() {
    if (this.process) return;

    const pythonBin = existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';

    this.process = spawn(pythonBin, [SERVER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    // Forward stderr to our stderr for logging
    this.process.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    this.readline = createInterface({ input: this.process.stdout });

    this._readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Vision server startup timed out (120s)'));
      }, 120000);

      // First line is the ready signal
      const onFirstLine = (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.ready) {
            clearTimeout(timeout);
            this.ready = true;
            console.error(`[vision-bridge] Server ready: model=${msg.model}, device=${msg.device}`);
            // Now switch to request-response mode
            this.readline.on('line', (l) => this._handleResponse(l));
            resolve(msg);
          }
        } catch (e) {
          clearTimeout(timeout);
          reject(new Error(`Failed to parse ready signal: ${e.message}`));
        }
      };

      this.readline.once('line', onFirstLine);
    });

    this.process.on('exit', (code) => {
      console.error(`[vision-bridge] Python process exited with code ${code}`);
      this.ready = false;
      // Reject any pending requests
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`Vision server exited (code ${code})`));
      }
      this.pending.clear();
    });

    this.process.on('error', (err) => {
      console.error(`[vision-bridge] Python process error: ${err.message}`);
    });

    return this._readyPromise;
  }

  _handleResponse(line) {
    try {
      const msg = JSON.parse(line);
      const id = msg.id;
      const pending = this.pending.get(id);
      if (!pending) {
        console.error(`[vision-bridge] Received response for unknown request id: ${id}`);
        return;
      }
      this.pending.delete(id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    } catch (e) {
      console.error(`[vision-bridge] Failed to parse response: ${e.message}`);
    }
  }

  /**
   * Send a JSON-RPC request to the Python server.
   */
  async _call(method, params = {}) {
    if (!this.ready) throw new Error('Vision server not ready');

    const id = ++this.requestId;
    const req = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(req + '\n');
    });
  }

  /** Health check */
  async health() {
    return this._call('health');
  }

  /**
   * Embed page images. paths is an array of image file paths.
   * Returns { embeddings: Float32Array[][], num_vectors: number[] }
   */
  async embedImages(paths) {
    const result = await this._call('embed_images', { paths });
    // Convert nested arrays to Float32Arrays
    return {
      embeddings: result.embeddings.map(pageVecs =>
        pageVecs.map(vec => new Float32Array(vec))
      ),
      num_vectors: result.num_vectors,
    };
  }

  /**
   * Embed a single query text.
   * Returns Float32Array[] (array of token vectors).
   */
  async embedQuery(text) {
    const result = await this._call('embed_query', { text });
    return result.embedding.map(vec => new Float32Array(vec));
  }

  /**
   * Embed multiple query texts.
   * Returns Float32Array[][] (array of arrays of token vectors).
   */
  async embedQueries(texts) {
    const result = await this._call('embed_queries', { texts });
    return result.embeddings.map(queryVecs =>
      queryVecs.map(vec => new Float32Array(vec))
    );
  }

  /**
   * Extract page images from a PDF.
   * Returns { paths: string[], page_count: number }
   */
  async extractPages(pdfPath, outputDir) {
    return this._call('extract_pages', { pdf_path: pdfPath, output_dir: outputDir });
  }

  /**
   * Gracefully shut down the Python server.
   */
  async stop() {
    if (!this.process) return;
    try {
      if (this.ready) {
        await this._call('shutdown');
      }
    } catch {
      // Ignore errors during shutdown
    }
    this.process.kill();
    this.process = null;
    this.ready = false;
    this.pending.clear();
  }
}

// Singleton instance
let _bridge = null;

export function getBridge() {
  if (!_bridge) _bridge = new VisionBridge();
  return _bridge;
}
