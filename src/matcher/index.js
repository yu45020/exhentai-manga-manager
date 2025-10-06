const path = require('path')
const Database = require('better-sqlite3')
const Piscina = require('piscina')
const{DECISION, REASONS} = require('./config')

const { matchOne, applyFtsPragmas } = require('./pipeline')
const { initTitleCoreIndex, isInited } = require('./fts.js')
const os = require('os')

// Resolve worker path relative to THIS folder (robust in Electron/asar)
const WORKER_DEFAULT = path.join(__dirname, 'matchWorker.piscina.js')

// Default console progress (your formatter), used if caller provides none
function makeConsoleProgress(prefix = 'matcher') {
  let lastPct = -1
  return ({ processed, total, pct, elapsedMs }) => {
    if (pct === lastPct) return // reduce noise
    lastPct = pct
    process.stdout.write(
        `[${prefix}] ${processed}/${total} (${pct}%) - ${Math.round(elapsedMs) / 1000}s\r`
    )
    if (pct === 100) process.stdout.write('\n')
  }
}

function createMatcher(
    dbPath,
    {
      workerPath = WORKER_DEFAULT,
      onProgress = null,
      verbose = true,
    } = {}
) {
  if (!dbPath) throw new Error('createMatcher: dbPath is required')

  const absDbPath = path.resolve(dbPath)

  // Fast readiness guard (read-only probe)
  const probe = new Database(absDbPath, { readonly: true, fileMustExist: true })
  const ready = isInited(probe)
  probe.close()
  if (!ready) {
    throw new Error('Database not initialized. Run initTitleCoreIndex() before using matcher.')
  }

  // Instance-level default progress sink
  const defaultProgress = onProgress || (verbose ? makeConsoleProgress('matcher') : () => {})

  /**
   * Run matching on a list of rows with a fresh Piscina pool.
   * Cleans up (destroy) after the run, including when aborted.
   */
  async function searchAll(
      rows,
      {
        poolSize,                 // e.g., 6
        signal,                   // AbortSignal
        overrideParams,           // extra params passed into worker
        progressEvery = 100 // emit progress every X intervals
      } = {}
  ) {
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return []
    progressEvery = Math.max(100, Number(progressEvery) || 100)

    const pool = new Piscina({
      filename: workerPath,
      maxThreads: poolSize ?? Math.max(2, Math.min(8, os.cpus().length - 1)),
      idleTimeout: 0,
    })

    const progress = defaultProgress

    const t0 = Date.now()
    let processed = 0

    const tasks = list.map((row) =>
        pool
            .run({ row, params: { dbPath: absDbPath, ...(overrideParams || {}) } }, { signal })
            .then((r) => {
              processed++
              if (processed % progressEvery === 0 || processed === list.length) {
                const elapsedMs = Date.now() - t0
                progress({
                  processed,
                  total: list.length,
                  pct: Math.round((processed / list.length) * 100),
                  elapsedMs,
                })
              }
              return r
            })
    )

    try {
      const settled = await Promise.allSettled(tasks)
      return settled.filter(x => x.status === 'fulfilled').map(x => x.value)
    } catch (e) {
      console.log('searchAll error', e)
    } finally {
      // Ensure threads are torn down even on abort/error
      try { await pool.destroy() } catch {}
    }
  }

  /**
   * Convenience single-title path (sync-ish). Opens a short-lived RO DB.
   */
  async function matchOneTitle(title, opts = {}) {
    const db = new Database(absDbPath, { readonly: true, fileMustExist: true })
    try {
      applyFtsPragmas(db)
      return matchOne(db, title, opts)
    } catch (e) {
      console.log('matchOneTitle error', e)
    } finally {
      try { db.close() } catch {}
    }
  }

  return { searchAll, matchOneTitle }
}

async function getMetadata(dbPath,                 // path to the probe DB (better-sqlite3) that has `gallery`
                           rows,                  //  rows from the Manga db to be matched
                           poolSize = 8,
                           progressEvery = 100,) {
  // 1) Ensure probe DB ready
  const probe = new Database(dbPath, { readonly: false, fileMustExist: true })
  try {
    if (!isInited(probe)) initTitleCoreIndex(probe)
  } catch (e) {
    console.log('getMetadata error', e)
  } finally {
    probe.close()
  }

  // 2) Fetch candidates (untagged) using your existing Sequelize connection

  // 3) Run matcher
  const matcher = createMatcher(dbPath)
  // [{row, matched, decision, reason, diagnostics}, ...]
  const results = await matcher.searchAll(rows, { progressEvery, poolSize })
  // 4) Keep results with a match
  const picks = results.filter(res => res.matched)

  if (!picks.length) return

  // 5) Open probe read-only and Manga DB
  const probeRO = new Database(dbPath, { readonly: true, fileMustExist: true })
  const getByGid = probeRO.prepare(`SELECT *
                                    FROM gallery
                                    WHERE gid = ?
                                    LIMIT 1`)
  const out = []
  for (const pick of picks) {
    const book = pick.row
    const metadata = getByGid.get(pick.matched.gid)
    if (metadata) {
      book.metadata = metadata
      book.matchedInfo = { decision: pick.decision, reason: pick.reason }
      out.push(book)
    }
  }

  probeRO.close()

  return out
}

TITLE_MATCHER = {
  decision: DECISION,
  reason: REASONS,
}


module.exports = { createMatcher, initTitleCoreIndex, isInited, getMetadata, TITLE_MATCHER}
