// matcher.pool.worker.js
// Process-backed worker used by Electron main via `workerpool`.
// It reuses matcher instances per dbPath so any internal Piscina pool stays warm
// for the lifetime of the process.
//
// Exposed API:
//   - ensure(dbPath)
//   - validate(dbPath)
//   - batchMatch(dbPath, rows, options?)  // options: { poolSize, progressEvery }
//
// Usage in main:
//   const pool = workerpool.pool(path.join(__dirname, 'matchPool.workerpool.js'), { workerType: 'process', minWorkers: 1, maxWorkers: 1 });
//   await pool.exec('ensure', [dbPath])
//   const p = pool.exec('batchMatch', [dbPath, rows, { poolSize: 8, progressEvery: 100 }])
//   p.progress(r => { /* 0..1 */ });
// WARNING:   MUST call `batchMatchBegin` to init a pool of threads
// `batchMatch` creates a matcher and calls batchMatchMetadata ==> searchAll,
// which then get a pool of threads;  the pool is alive in order to batch match rows
// call batchMatchEnd after at the end of batch.
//
const workerpool = require('workerpool')
const { createMatcher } = require('./index.js')
const { isPoolActive, getPoolStats, getPool } = require('./pipeline.js')
const os = require('os')
const path = require('path') // your standalone matcher module

// Cache one matcher per dbPath so its internal Piscina pool stays warm.
const matcherCache = new Map()
const jobController = new AbortController()

async function getMatcher(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('Invalid dbPath')
  }
  let m = matcherCache.get(dbPath)
  if (!m) {
    m = createMatcher(dbPath)
    // only check whether it is validated; never init it here
    await m.validateDatabase()
    matcherCache.set(dbPath, m)
  }
  return m
}


// --- exposed worker functions ---

/**
 * Ensure the database is initialized / migrated as needed.
 * @param {string} dbPath
 */
async function ensure(dbPath) {
  const m = getMatcher(dbPath)
  return await m.ensureDatabase()
}

/**
 * Validate database (check-only).
 * @param {string} dbPath
 */
async function validate(dbPath) {
  const m = getMatcher(dbPath)
  return await m.validateDatabase()
}

/**
 * Batch fuzzy match book titles and attach matched metadata onto rows.
 * Matches your function signature:
 *    batchMatchMetadata(rows, poolSize = 8, progressEvery = 100)
 *
 * @param {string} dbPath
 * @param {Array<object>} rows  Rows from the Manga DB to be matched
 * @param {{poolSize?: number, progressEvery?: number}} [options]
 * @returns {Promise<Array<object>>} Matched rows with `metadata` and `matchedInfo` attached
 */
async function batchMatch(dbPath, rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw new Error('batchMatch expects an array of rows')
  }

  const m = await getMatcher(dbPath)
  const signal = jobController?.signal
  const poolSize = Number.isFinite(options.poolSize) ? options.poolSize : Math.max(1, Number(Math.min(os.cpus().length - 2, 8)))
  const progressEvery = Number.isFinite(options.progressEvery) ? options.progressEvery : 100

  return await m.batchMatchMetadata(rows, poolSize, progressEvery, signal)
}


/**
 * Session based Pool Management
 * */
const WORKER_DEFAULT = path.join(__dirname, 'matchWorker.piscina.js')


async function batchMatchBegin(dbPath, opts = {}) {
  getPool({ filename: WORKER_DEFAULT, poolSize: opts.poolSize })
  return { ok: true }
}


async function batchMatchEnd(dbPath) {
  try { await cancelCurrentJob() } catch {}
  const matcher = matcherCache.get(dbPath)
  if (matcher) {
    try {await matcher.destroySearchPool()} catch {}
    matcherCache.set(dbPath, null)
  }
}

async function cancelCurrentJob() {
  if (jobController && jobController.signal.aborted) {
    try { jobController.abort() } catch {}
  }
  return { ok: true }
}

async function poolIsActive() { return isPoolActive() }

async function poolStats() { return getPoolStats() }


workerpool.worker({
  ensure,
  validate,
  batchMatch,
  batchMatchBegin,
  batchMatchEnd,
  poolIsActive,
  poolStats
})
