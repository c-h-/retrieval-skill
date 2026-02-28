/**
 * `retrieve up` / `retrieve down` — start and stop the full retrieval stack.
 *
 * Manages:
 *  - octen-embeddings-server (embedding model server)
 *  - retrieval-skill scheduler (launchd periodic sync + index)
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { runDoctor } from './doctor.mjs';

const OCTEN_SERVER_DIR = process.env.OCTEN_SERVER_DIR || join(homedir(), 'personal', 'octen-embeddings-server');
const OCTEN_PLIST_LABEL = process.env.OCTEN_PLIST_LABEL || 'com.openclaw.octen-embeddings';
const RETRIEVAL_PLIST_LABEL = process.env.RETRIEVAL_PLIST_LABEL || 'com.retrieval-skill.sync';
const OCTEN_PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${OCTEN_PLIST_LABEL}.plist`);
const RETRIEVAL_PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${RETRIEVAL_PLIST_LABEL}.plist`);
const EMBEDDING_SERVER_URL = process.env.EMBEDDING_SERVER_URL || 'http://localhost:8100';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function log(msg) {
  console.log(`  ${msg}`);
}

function isPortListening(port) {
  try {
    const out = execSync(`lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function isLaunchdLoaded(label) {
  try {
    const out = execSync(`launchctl list 2>/dev/null | grep ${label}`, { encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

async function waitForHealth(url, timeoutMs = 30000) {
  const start = Date.now();
  const interval = 1000;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok' || data.status === 'healthy') return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// ── retrieve up ──

export async function stackUp() {
  console.log(`\n${BOLD}retrieve up${RESET}\n`);

  // 1. Start embedding server
  const port = new URL(EMBEDDING_SERVER_URL).port || '8100';
  if (isPortListening(port)) {
    log(`${GREEN}Embedding server already running on :${port}${RESET}`);
  } else {
    log(`Starting embedding server...`);
    if (existsSync(OCTEN_PLIST_PATH)) {
      try {
        execSync(`launchctl load ${OCTEN_PLIST_PATH} 2>/dev/null`, { encoding: 'utf-8' });
        log(`  Loaded ${OCTEN_PLIST_LABEL} via launchd`);
      } catch {
        log(`  ${RED}Failed to load ${OCTEN_PLIST_LABEL} plist${RESET}`);
      }
    } else if (existsSync(OCTEN_SERVER_DIR)) {
      const venvActivate = join(OCTEN_SERVER_DIR, '.venv', 'bin', 'activate');
      if (existsSync(venvActivate)) {
        try {
          execSync(
            `cd "${OCTEN_SERVER_DIR}" && source .venv/bin/activate && python3 server.py &`,
            { shell: '/bin/bash', stdio: 'ignore', detached: true },
          );
          log(`  Started server directly from ${OCTEN_SERVER_DIR}`);
        } catch {
          log(`  ${RED}Failed to start server from ${OCTEN_SERVER_DIR}${RESET}`);
        }
      } else {
        log(`  ${RED}No .venv found in ${OCTEN_SERVER_DIR}${RESET}`);
      }
    } else {
      log(`  ${RED}No plist at ${OCTEN_PLIST_PATH} and no server dir at ${OCTEN_SERVER_DIR}${RESET}`);
    }
  }

  // 2. Wait for embedding server health
  if (!isPortListening(port)) {
    log(`Waiting for embedding server to start...`);
  }
  const healthy = await waitForHealth(EMBEDDING_SERVER_URL, 30000);
  if (healthy) {
    log(`${GREEN}Embedding server healthy${RESET}`);
  } else {
    log(`${RED}Embedding server did not become healthy within 30s${RESET}`);
  }

  // 3. Start scheduler
  if (isLaunchdLoaded(RETRIEVAL_PLIST_LABEL)) {
    log(`${GREEN}Scheduler ${RETRIEVAL_PLIST_LABEL} already loaded${RESET}`);
  } else if (existsSync(RETRIEVAL_PLIST_PATH)) {
    try {
      execSync(`launchctl load ${RETRIEVAL_PLIST_PATH}`, { encoding: 'utf-8' });
      log(`${GREEN}Loaded scheduler ${RETRIEVAL_PLIST_LABEL}${RESET}`);
    } catch {
      log(`${RED}Failed to load scheduler ${RETRIEVAL_PLIST_LABEL}${RESET}`);
    }
  } else {
    log(`${RED}No scheduler plist found — run: bash scheduling/setup.sh install${RESET}`);
  }

  // 4. Run doctor
  console.log('');
  return runDoctor();
}

// ── retrieve down ──

export async function stackDown() {
  console.log(`\n${BOLD}retrieve down${RESET}\n`);

  // 1. Stop scheduler
  if (isLaunchdLoaded(RETRIEVAL_PLIST_LABEL)) {
    try {
      execSync(`launchctl unload ${RETRIEVAL_PLIST_PATH} 2>/dev/null`, { encoding: 'utf-8' });
      log(`${GREEN}Unloaded scheduler ${RETRIEVAL_PLIST_LABEL}${RESET}`);
    } catch {
      log(`${RED}Failed to unload scheduler${RESET}`);
    }
  } else {
    log(`${DIM}Scheduler already stopped${RESET}`);
  }

  // 2. Stop embedding server
  if (isLaunchdLoaded(OCTEN_PLIST_LABEL)) {
    try {
      execSync(`launchctl unload ${OCTEN_PLIST_PATH} 2>/dev/null`, { encoding: 'utf-8' });
      log(`${GREEN}Unloaded embedding server ${OCTEN_PLIST_LABEL}${RESET}`);
    } catch {
      log(`${RED}Failed to unload embedding server plist${RESET}`);
    }
  }

  // Also kill by port in case it was started directly
  const port = new URL(EMBEDDING_SERVER_URL).port || '8100';
  if (isPortListening(port)) {
    try {
      const pids = execSync(`lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (pids) {
        execSync(`kill ${pids}`, { encoding: 'utf-8' });
        log(`${GREEN}Killed embedding server process(es) on :${port}${RESET}`);
      }
    } catch {
      log(`${RED}Failed to kill embedding server on :${port}${RESET}`);
    }
  } else if (!isLaunchdLoaded(OCTEN_PLIST_LABEL)) {
    log(`${DIM}Embedding server already stopped${RESET}`);
  }

  // 3. Confirm
  await new Promise((r) => setTimeout(r, 500));
  const schedulerStopped = !isLaunchdLoaded(RETRIEVAL_PLIST_LABEL);
  const serverStopped = !isPortListening(port);
  console.log('');
  if (schedulerStopped && serverStopped) {
    log(`${GREEN}All services stopped${RESET}`);
    return true;
  }
  if (!schedulerStopped) log(`${RED}Scheduler still running${RESET}`);
  if (!serverStopped) log(`${RED}Embedding server still running on :${port}${RESET}`);
  return false;
}
