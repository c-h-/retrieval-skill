import { checkEmbeddingServer } from './health.mjs';
import { reindexByName } from './index.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reindexAllWithRetry({
  indexes = ['slack', 'notion', 'linear', 'mono'],
  maxAttempts = 3,
  backoffMs = [30_000, 120_000, 300_000],
  healthCheckBetweenAttempts = true,
} = {}) {
  const summary = [];

  for (const name of indexes) {
    const start = Date.now();
    let lastError = null;
    let attempts = 0;
    let status = 'failed';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        await reindexByName(name);
        status = 'ok';
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.error(`[retry] ${name} attempt ${attempt}/${maxAttempts} failed: ${err.message}`);

        if (attempt < maxAttempts) {
          const delay = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 30_000;
          console.error(`[retry] waiting ${delay}ms before retry...`);
          await sleep(delay);

          if (healthCheckBetweenAttempts) {
            const health = await checkEmbeddingServer();
            if (!health.ok) {
              console.error(`[retry] embedding server unhealthy, aborting retries for ${name}`);
              break;
            }
          }
        }
      }
    }

    const entry = { name, status, attempts, durationMs: Date.now() - start };
    if (lastError) entry.error = lastError.message;
    summary.push(entry);
  }

  const allOk = summary.every((s) => s.status === 'ok');
  return { summary, allOk };
}
