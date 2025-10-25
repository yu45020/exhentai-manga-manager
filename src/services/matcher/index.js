const path = require('path')
const Database = require('better-sqlite3')
const { DECISION, REASONS } = require('./config')
const { checkGallerySchema } = require('./isAPIDumpDB.js')
const { searchOne, applyFtsPragmas, destroyPool, getPool } = require('./pipeline')
const { initTitleCoreIndex, isDBInited } = require('./fts.js')
const os = require('os')
const workerpool = require('workerpool')


const TITLE_MATCHER = {
  decision: DECISION,
  reason: REASONS,
}
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
  // Instance-level default progress sink
  const defaultProgress = onProgress || (verbose ? makeConsoleProgress('matcher') : () => {})

  const absDbPath = path.resolve(dbPath)
  let isValidated = null


  async function validateDatabase() {
    const db = new Database(absDbPath, { readonly: true, fileMustExist: true })
    try {
      const isValidate = await checkGallerySchema(db)
      if (!isValidate.exactMatch) {
        isValidated = { isValidDb: false, isInited: false }
        return isValidated
      }
      const isInited = isDBInited(db)
      isValidated = { isValidDb: isValidate.exactMatch, isInited }
      return isValidated
    } catch (e) {
      console.log('validateDatabase error', e)
      isValidated = { isValidDb: false, isInited: false }
      return isValidated
    } finally {
      db.close()
    }
  }

  async function ensureDatabase() {
    if (isValidated === null) await validateDatabase()
    if (!isValidated.isValidDb) throw new Error('Database is not validated')
    if (isValidated.isInited) return true
    const probe = new Database(absDbPath, { readonly: false, fileMustExist: true })
    try {
      initTitleCoreIndex(probe)
      return true
    } catch (e) {
      console.log('ensureDatabase error', e)
      return false
    } finally {
      probe.close()
    }
  }

  async function isDBReady() {
    if (isValidated === null) throw new Error('Database is not validated. Run ensureDatabase()')
    if (!isValidated.isValidDb) throw new Error('Database is not validated')
    if (!isValidated.isInited) throw new Error('Database is not initialized yet. Run ensureDatabase().')

  }

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
    await isDBReady()

    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return []
    progressEvery = Math.max(100, Number(progressEvery) || 100)
    // Reuse a persistent pool (lazy-inited). No per-call cold start.
    // The pool is init in the `matchPool.workerpool.js`
    const pool = getPool({
      filename: workerPath,                           // your previous workerPath
      poolSize: poolSize ?? Math.max(2, Math.min(8, os.cpus().length - 1)),
      createNew: false
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
    }
  }

  async function destroySearchPool() {
    await destroyPool()
  }

  /**
   * Convenience single-title path (sync-ish). Opens a short-lived RO DB.
   */
  async function SearchOneTItle(title, opts = {}) {
    await isDBReady()
    const db = new Database(absDbPath, { readonly: true, fileMustExist: true })
    try {
      applyFtsPragmas(db)
      return searchOne(db, title, opts)
    } catch (e) {
      console.log('SearchOneTItle error', e)
    } finally {
      try { db.close() } catch {}
    }
  }

  async function batchMatchMetadata(rows, //  rows from the Manga db to be matched
                                    poolSize = 8,
                                    progressEvery = 100,
                                    signal = null) {
    if (rows.length === 0) return []
    await isDBReady()
    // [{row, matched, decision, reason, diagnostics}, ...]
    const results = await searchAll(rows, { progressEvery, poolSize, signal })
    // 4) Keep results with a match
    const picks = results.filter(res => res.matched)

    if (!picks.length) return []

    // 5) Open probe read-only and Manga DB
    const probeRO = new Database(absDbPath, { readonly: true, fileMustExist: true })
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
        book.matchedInfo = {
          decision: pick.decision,
          reason: pick.reason,
          isExactMatch: pick.decision === DECISION.exact,
          score: pick.score
        }
        out.push(book)
      }
    }

    probeRO.close()

    return out
  }

  // fetch one row from gallery table by gid, token.
  // used to update by EhViewer
  // no need to init the db as we only need to read the data, no matching

  async function matchByGidToken(gidTokenList,) {
    // [{gid, token, book}, ...]
    if (isValidated === null) await validateDatabase()
    if (!isValidated.isValidDb) throw new Error('Database is not validated')
    const db = new Database(absDbPath, { readonly: true, fileMustExist: true })
    const stmt = db.prepare('SELECT * FROM gallery WHERE gid = ? AND token = ?')

    const runTxn = db.transaction((pairs) => {
      const out = []
      for (const { gid, token, book } of pairs) {
        const row = stmt.get(gid, token)
        if (row) {
          book.metadata = row
          out.push({ gid, token, book })
        }
      }
      return out
    })
    return runTxn(gidTokenList)
  }

  return {
    searchAll,
    matchOneTitle: SearchOneTItle,
    batchMatchMetadata,
    validateDatabase,
    ensureDatabase,
    destroySearchPool,
    matchByGidToken
  }
}

const POOL_DEFAULT = path.join(__dirname, 'matchPool.workerpool.js')

function makeMatcherPool() {
  return workerpool.pool(POOL_DEFAULT, {
    workerType: 'process',
    minWorkers: 1,
    maxWorkers: 1,
    forkOpts: { stdio: 'inherit' },
  })
}

module.exports = { createMatcher, initTitleCoreIndex, makeMatcherPool, TITLE_MATCHER }
