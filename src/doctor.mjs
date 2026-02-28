/**
 * `retrieve doctor` — check the full stack health.
 *
 * Checks:
 *  1. Embedding server reachable
 *  2. Connector credentials configured
 *  3. Index freshness
 *  4. Disk space
 *  5. Scheduler status (launchd)
 */

import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const EMBEDDING_SERVER_URL = process.env.EMBEDDING_SERVER_URL || 'http://localhost:8100';
const INDEX_DIR = join(homedir(), '.retrieval-skill', 'indexes');
const RETRIEVAL_PLIST_LABEL = process.env.RETRIEVAL_PLIST_LABEL || 'com.retrieval-skill.sync';

// ANSI color helpers
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function pass(msg) {
  return `${GREEN}PASS${RESET}  ${msg}`;
}
function fail(msg) {
  return `${RED}FAIL${RESET}  ${msg}`;
}
function warn(msg) {
  return `${YELLOW}WARN${RESET}  ${msg}`;
}

// ── Check 1: Embedding server ──

async function checkEmbeddingServer() {
  try {
    const res = await fetch(`${EMBEDDING_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, msg: `Embedding server returned ${res.status}` };
    const data = await res.json();
    const status = data.status || 'unknown';
    if (status === 'ok' || status === 'healthy') {
      const extra = data.requests_served != null ? ` (${data.requests_served} requests served)` : '';
      return { ok: true, msg: `Embedding server healthy at ${EMBEDDING_SERVER_URL}${extra}` };
    }
    return { ok: false, msg: `Embedding server status: ${status}` };
  } catch (err) {
    return { ok: false, msg: `Embedding server unreachable at ${EMBEDDING_SERVER_URL}` };
  }
}

// ── Check 2: Connector credentials ──

const CONNECTOR_VARS = {
  Slack: ['SLACK_BOT_TOKEN'],
  Notion: ['NOTION_TOKEN'],
  Linear: ['LINEAR_API_KEY'],
  Gmail: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'],
  GOG: ['GOG_ACCOUNT'],
};

function checkConnectorCredentials() {
  const configured = [];
  const missing = [];

  for (const [name, vars] of Object.entries(CONNECTOR_VARS)) {
    const hasAll = vars.every((v) => process.env[v]);
    if (hasAll) {
      configured.push(name);
    } else {
      missing.push(name);
    }
  }

  if (configured.length === 0) {
    return { ok: false, msg: 'No connectors configured — set credentials in .env' };
  }
  const configuredStr = configured.join(', ');
  const missingStr = missing.length > 0 ? `${DIM} (not configured: ${missing.join(', ')})${RESET}` : '';
  return { ok: true, msg: `Connectors: ${configuredStr}${missingStr}` };
}

// ── Check 3: Index freshness ──

function checkIndexFreshness() {
  try {
    const files = readdirSync(INDEX_DIR).filter((f) => f.endsWith('.db'));
    if (files.length === 0) {
      return { ok: false, msg: `No indexes found in ${INDEX_DIR}` };
    }

    const results = [];
    let oldestDays = 0;
    for (const f of files) {
      const fullPath = join(INDEX_DIR, f);
      const stat = statSync(fullPath);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > oldestDays) oldestDays = ageDays;
      const name = f.replace(/\.db$/, '');
      const ago = ageDays < 1 ? `${Math.round(ageDays * 24)}h ago` : `${Math.round(ageDays)}d ago`;
      const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
      results.push(`${name} ${DIM}(${sizeMb} MB, updated ${ago})${RESET}`);
    }

    const ok = oldestDays < 2; // warn if any index older than 2 days
    return {
      ok,
      warn: !ok,
      msg: `${files.length} index(es): ${results.join(', ')}`,
    };
  } catch {
    return { ok: false, msg: `Index directory not found: ${INDEX_DIR}` };
  }
}

// ── Check 4: Disk space ──

function checkDiskSpace() {
  try {
    const output = execSync('df -h .', { encoding: 'utf-8' });
    const lines = output.trim().split('\n');
    if (lines.length < 2) return { ok: true, msg: 'Could not parse disk info' };
    const parts = lines[1].split(/\s+/);
    const available = parts[3];
    const usePct = parseInt(parts[4], 10);
    if (usePct > 90) {
      return { ok: false, msg: `Disk ${usePct}% full (${available} available) — critically low` };
    }
    if (usePct > 80) {
      return { ok: true, warn: true, msg: `Disk ${usePct}% full (${available} available)` };
    }
    return { ok: true, msg: `Disk ${available} available (${usePct}% used)` };
  } catch {
    return { ok: true, msg: 'Could not check disk space' };
  }
}

// ── Check 5: Scheduler status ──

function checkScheduler() {
  try {
    const output = execSync(`launchctl list 2>/dev/null | grep ${RETRIEVAL_PLIST_LABEL}`, {
      encoding: 'utf-8',
    });
    if (output.trim()) {
      const parts = output.trim().split('\t');
      const pid = parts[0];
      const running = pid !== '-' ? ` (PID ${pid})` : '';
      return { ok: true, msg: `Scheduler ${RETRIEVAL_PLIST_LABEL} loaded${running}` };
    }
    return { ok: false, msg: `Scheduler ${RETRIEVAL_PLIST_LABEL} not loaded` };
  } catch {
    return { ok: false, msg: `Scheduler ${RETRIEVAL_PLIST_LABEL} not loaded — run: bash scheduling/setup.sh install` };
  }
}

// ── Main ──

export async function runDoctor() {
  console.log(`\n${BOLD}retrieve doctor${RESET}\n`);

  const checks = [
    { name: 'Embedding server', fn: checkEmbeddingServer },
    { name: 'Connectors', fn: checkConnectorCredentials },
    { name: 'Indexes', fn: checkIndexFreshness },
    { name: 'Disk space', fn: checkDiskSpace },
    { name: 'Scheduler', fn: checkScheduler },
  ];

  let allCriticalOk = true;
  const criticalChecks = new Set(['Embedding server', 'Connectors']);

  for (const check of checks) {
    const result = await check.fn();
    if (result.warn) {
      console.log(warn(result.msg));
    } else if (result.ok) {
      console.log(pass(result.msg));
    } else {
      console.log(fail(result.msg));
      if (criticalChecks.has(check.name)) {
        allCriticalOk = false;
      }
    }
  }

  console.log('');
  return allCriticalOk;
}
