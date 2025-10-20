/** Given a raw title, match it to a book in the database.
 * */

const { normalizeTitle } = require('./normalizer.js')
const Fuse = require('fuse.js')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')

const Piscina = require('piscina')

const {
  DEFAULTS, DEFAULT_FUSE_OPTS, DECISION, REASONS, PREFERRED_LANGS
} = require('./config.js')

/** ------------------------ Main ------------------------ */
function searchOne(db, title_raw, options = {}) {
  // return the id of the best match
  const CFG = { ...DEFAULTS, ...options }

  const stmts = prepareStatements(db, CFG)
  const norms = normalizeTitle(title_raw)

  // Stage A — exact
  const res = exactMatch(stmts, norms)
  if (res.matched) return res

  // Stage B — FTS only [{gid, bm25}... ]
  const candidates = filterCandidatesFTS(stmts, norms, CFG)

  // Stage C — fuzzy on the candidates 
  return fuzzyMatch(stmts, candidates, norms, CFG)
}

// Optional: one-time FTS perf tuning (call after opening DB)
function applyFtsPragmas(db, {
  cacheSizePages = -250000, // 256MB (negative means KB pages)
  mmapSizeBytes = 2147483648, // 2 GiB
  tempStore = 2, // forces temp structures into memory
  synchronous = 'OFF', //
  journalMode = 'WAL',
} = {},) {
  db.pragma(`cache_size=${cacheSizePages}`)
  db.pragma(`mmap_size=${mmapSizeBytes}`)
  db.pragma(`temp_store=${tempStore}`)
  db.pragma(`synchronous=${synchronous}`)
  db.pragma(`journal_mode=${journalMode}`)
}

/* ------------------------ helpers  ------------------------ */

const takeFirstN = (arr, n) => (arr.length > n ? arr.slice(0, n) : arr)

/* ------------------------ Prepared sql statements ------------------------ */

function prepareStatements(db, CFG = DEFAULTS) {
  // only need the gid as we will get all rows in batch later
  const {
    TABLE_TCI, TABLE_FTS, COL_ID, COL_RAW, COL_FULL, COL_CORE, LIMIT_FULL, LIMIT_CORE,
  } = CFG
  return {
    exactFull: db.prepare(`SELECT ${COL_ID} AS gid
                           FROM ${TABLE_TCI}
                           WHERE ${COL_FULL} = ?
                           LIMIT ${LIMIT_FULL};`),

    exactCore: db.prepare(`SELECT ${COL_ID} AS gid
                           FROM ${TABLE_TCI}
                           WHERE ${COL_CORE} = ?
                           LIMIT ${LIMIT_CORE};`),

    // FTS5 table fix rowid as the primary key， bm25 smaller is better
    ftsQuery: db.prepare(`
        SELECT rowid              AS gid,
               bm25(${TABLE_FTS}) AS bm25
        FROM ${TABLE_FTS}
        WHERE ${TABLE_FTS} MATCH ?
        ORDER BY bm25 ASC
        LIMIT ?;
    `),

    // For fuzzy search
    getTitles: (gids) => {
      if (!gids.length) return { all: () => [] }
      const placeholders = gids.map(() => '?').join(',')
      return db.prepare(`
          SELECT t.${COL_ID}   AS gid,
                 t.${COL_FULL} AS title_full_norm,
                 t.${COL_CORE} AS title_core_norm,
                 g.language    as language
          FROM ${TABLE_TCI} as t
                   LEFT JOIN gallery AS g
                             ON g.gid = t.${COL_ID}
          WHERE t.${COL_ID} IN (${placeholders});
      `).all(...gids)
    },
  }
}

/* ------------------------ Build FTS query variants ------------------------ */

function buildFtsQueries(norms, {
  maxBoWTokens = 12, minTokenLen = 1, addBackoffs = true, minBackoffTigger = 3, // 5 seems too large
  minK = 2, //smallest useful subsets for the AND query
} = {},) {
  const RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR'])
  const wash = (t) => {
    const tt = String(t || '').trim()
    if (!tt || RESERVED.has(tt.toUpperCase()) || /["\s]/.test(tt)) {
      return `"${tt.replace(/"/g, '""')}"`
    }
    return tt
  }
  const mk = (arr) => arr.map((t) => `title_core_norm_seg:${wash(t)}`).join(' ')

  const seg = norms.title_core_norm_seg
  if (!seg) return []

  // normalize/dedupe/cap source tokens (don’t exceed 4× cap to keep work bounded)
  const seen = new Set()
  const toks = []
  for (const raw of seg.split(/\s+/)) {
    const tok = raw.toLowerCase().trim()
    if (!tok || tok.length < minTokenLen) continue
    if (seen.has(tok)) continue
    seen.add(tok)
    toks.push(tok)
    if (toks.length >= maxBoWTokens * 4) break
  }
  const n = toks.length
  if (!n) return []

  // helper: pick m tokens spread across the array (coverage without many queries)
  const pickSpread = (arr, m) => {
    if (m >= arr.length) return arr.slice()
    const out = []
    for (let i = 0; i < m; i++) {
      const idx = Math.round((i * (arr.length - 1)) / (m - 1))
      if (out.length === 0 || arr[idx] !== out[out.length - 1]) out.push(arr[idx])
    }
    return out
  }

  const cap = (lo, hi, x) => Math.max(lo, Math.min(hi, x))
  const queries = []
  if (n <= maxBoWTokens) {
    // Short titles: use all tokens
    queries.push(mk(toks))
    if (addBackoffs && n >= minBackoffTigger) {
      /** Each back-off is a subset of the previous query’s tokens, and results tend to be a superset.
       *  We can early-stop as soon as we have enough matches
       * Q1 uses all n tokens.
       * Q2 uses the first k2 ⊂ Q1.
       * Q3 uses the first k3 ⊂ Q2.*/
          // Q2 = ceil(2n/3) but at most n-1 and at least MIN_K
      const k2 = cap(minK, n - 1, Math.ceil((n * 2) / 3))
      // Q3 = ceil(n/2) but < k2 and ≥ minK
      const k3 = cap(minK, k2 - 1, Math.ceil(n / 2))
      // Only push if the size actually shrinks
      if (k2 < n) queries.push(mk(toks.slice(0, k2)))
      if (k3 < k2) queries.push(mk(toks.slice(0, k3)))
    }
  } else {
    // Long titles: start with a capped, spread subset (not head-only)
    const k1 = maxBoWTokens
    const head = pickSpread(toks, k1)
    queries.push(mk(head))

    if (addBackoffs) {
      // Back-offs derived from k1, and strictly decreasing
      const k2 = cap(minK, k1 - 1, Math.ceil((k1 * 2) / 3))
      const k3 = cap(minK, k2 - 1, Math.ceil(k1 / 2))
      const q2 = pickSpread(toks, k2)
      if (k2 < k1) queries.push(mk(q2))
      const q3 = pickSpread(toks, k3)
      if (k3 < k2) queries.push(mk(q3))
    }
  }

  // de-dup while preserving order
  return Array.from(new Set(queries))
}

/* ------------------------ Matching pipeline ------------------------ */

// ————————————————————————
// Stage A — exact matches
// ————————————————————————
function exactMatch(stmts, norms) {
  if (norms.title_full_norm) {
    const fullHits = stmts.exactFull.all(norms.title_full_norm)
    if (fullHits.length === 1) {
      return {
        decision: DECISION.exact,
        reason: REASONS.exact_full,
        matched: { gid: fullHits[0].gid },
        diagnostics: { norms }
      }
    } else if (fullHits.length > 1) {
      return {
        decision: DECISION.review,
        reason: REASONS.exact_full_collision,
        matched: { gid: fullHits[0].gid },
        diagnostics: { norms }
      }
    }
  }

  if (norms.title_core_norm) {
    const coreHits = stmts.exactCore.all(norms.title_core_norm)
    if (coreHits.length === 1) {
      return {
        decision: DECISION.review,
        reason: REASONS.exact_core,
        matched: { gid: coreHits[0].gid, },
        diagnostics: { norms }
      }
    } else if (coreHits.length > 1) {
      return {
        decision: DECISION.review,
        reason: REASONS.exact_core_collision,
        matched: { gid: coreHits[0].gid, },
        diagnostics: { norms }
      }
    }
  }

  return {
    decision: DECISION.none,
    reason: REASONS.no_exact,
    matched: null,
    diagnostics: { norms }
  }
}

// ————————————————————————
// Stage B — FTS only (accuracy-first)
// Returns sorted [{id, bm25}] capped to FTS_TOPN
// ————————————————————————
function filterCandidatesFTS(stmts, norms, CFG = DEFAULTS) {
  const queries = buildFtsQueries(norms)
  const bestById = new Map() // id -> {id, bm25}
  if (!bestById) return []
  for (const q of queries) {
    // console.log('query', q)
    const rows = stmts.ftsQuery.all(q, CFG.FTS_TOPN)
    // Keep the best (lowest bm25) per id
    for (const row of rows) {
      const prev = bestById.get(row.gid)
      if (!prev || row.bm25 < prev.bm25) bestById.set(row.gid, row)
    }
    // If we already have a healthy pool, we can stop early.
    if (bestById.size >= CFG.FTS_TOPN) break
  }
  // Sort ascending by bm25 (lower is better), cap to FTS_TOPN
  const ranked = Array.from(bestById.values()).sort((a, b) => a.bm25 - b.bm25)
  return takeFirstN(ranked, CFG.FTS_TOPN)
}

// ————————————————————————
// Stage C — Fuzzy search on BM25-filtered candidates
// ————————————————————————
function fuzzyMatch(stmts, ranked, norms, CFG = DEFAULTS) {
  if (!ranked.length) {
    return {
      decision: DECISION.none,
      reason: REASONS.no_candidates,
      matched: null,
      diagnostics: { norms }
    }
  }

  const q = String(norms.title_core_norm || '').trim()
  if (!q) {
    // fall back to bm25 top if we somehow lack a query
    return {
      decision: DECISION.review,
      reason: REASONS.no_candidates,
      matched: { gid: ranked[0].gid, },
      diagnostics: { norms }
    }
  }

  const candidates = takeFirstN(ranked, CFG.RERANK_TOPK)
  const candidateTitles = stmts.getTitles(candidates.map(x => x.gid))

  // fuzzy match
  /** add weight by language (score post-adjust) */
  const fuseOpts = {
    ...DEFAULT_FUSE_OPTS, includeScore: true
  }


  // const ACCEPT_SCORE = typeof CFG.FUSE_ACCEPT_SCORE === 'number' ? CFG.FUSE_ACCEPT_SCORE : 0.25

  const fuse = new Fuse(candidateTitles, fuseOpts)
  const results = fuse.search(q, { limit: DEFAULTS.RERANK_TOPK })
  // console.log(results)
  if (!results.length) {
    return {
      decision: DECISION.review,
      reason: REASONS.fall_back_bm25,
      matched: { gid: ranked[0].gid },
      diagnostics: { norms }
    }
  } else {
    const top = results
        .map(r => ({ ...r, adjustedScore: adjustScoreByLanguage(r) }))
        .sort((a, b) => a.adjustedScore - b.adjustedScore)[0]  // top-1

    // const score = typeof top.score === 'number' ? top.score : 1
    return {
      decision: DECISION.review,
      reason: REASONS.fuzzy_rank,
      matched: { gid: top.item.gid },
      diagnostics: { norms }
    }
  }
}

function adjustScoreByLanguage(r) {
  function isPreferredLanguageString(lang) {
    if (lang == null) return true

    const s = String(lang).trim()
    if (!s) return true

    const low = s.toLowerCase()
    if (low === 'null' || low === 'none' || low === 'undefined' || low === '[]') return true

    // Whole-word match for 'chinese' or 'japanese' anywhere in the string
    return /\b(chinese|japanese)\b/i.test(s)
  }

// A lower score is better in Fuse. Multiply preferred by ? (tune as needed)
  const base = r.score ?? 1
  const preferred = isPreferredLanguageString(r.item.language)
  const factorPreferredLanguage = DEFAULT_FUSE_OPTS.factorPreferredLanguage // boost cn/jp/null
  const factorDefault = 1.00
  // console.log("adjustScoreByLanguage", r, base, preferred, factorPreferred, factorDefault,)
  return base * (preferred ? factorPreferredLanguage : factorDefault)

}


/**------------------------- Thread Management ------------------------*/

function getPool({ filename, poolSize, createNew=true } = {}) {
  if(createNew === false && !pool) throw new Error('no pool')
  if (!pool) {
    console.log('create new pool')
    pool = new Piscina({
      filename,
      minThreads: 1,
      maxThreads: poolSize ?? Math.max(2, Math.min(8, os.cpus().length - 1)),
      idleTimeout: 60_000,       // optional: auto-trim after idle
    })
  }
  return pool
}

async function destroyPool() {
  if (pool) {
    const p = pool
    pool = null
    await p.destroy()
  }
}


function isPoolActive() {
  return !!pool
}

function getPoolStats() {
  if (!pool) return { active: false }
  // Some fields depend on Piscina version; these are safe:
  return {
    active: true,
    minThreads: pool.options?.minThreads,
    maxThreads: pool.options?.maxThreads,
    // queueSize exists on Piscina and is useful for monitoring
    queueSize: pool.queueSize,
    // threads length may not be public on all versions; guard it:
    threadCount: Array.isArray(pool.threads) ? pool.threads.length : undefined,
  }
}

// ---- per-thread state (each worker thread has its own module instance) ----
let pool = null
let currentDbPath = null
let currentDb = null
const MAX_DB_CACHE = 2 // set to 0 to disable caching
const dbCache = new Map()

function openDb(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  applyFtsPragmas(db)
  return db
}

function safeClose(db) { try { db.close() } catch (_) {} }

function ensureDb(dbPath) {
  if (!dbPath) throw new Error('search worker: params.dbPath is required')

  // Fast path: same DB as last task on this worker
  if (currentDb && currentDbPath === dbPath) return currentDb

  // If we cached this DB earlier, reuse it
  if (dbCache.has(dbPath)) {
    // Optionally cache the old current one
    if (currentDb && currentDbPath && !dbCache.has(currentDbPath)) {
      dbCache.set(currentDbPath, currentDb)
    }
    currentDb = dbCache.get(dbPath)
    currentDbPath = dbPath
    return currentDb
  }

  // Need to open a new handle
  const db = openDb(dbPath)

  // Cache the previous current DB (optional)
  if (currentDb && currentDbPath) {
    dbCache.set(currentDbPath, currentDb)
  }

  // Evict if cache too big
  if (MAX_DB_CACHE >= 0) {
    while (dbCache.size > MAX_DB_CACHE) {
      // simple FIFO-ish eviction (you can swap to LRU if you like)
      const [victimPath, victimDb] = dbCache.entries().next().value
      dbCache.delete(victimPath)
      safeClose(victimDb)
    }
  }

  currentDb = db
  currentDbPath = dbPath
  return currentDb
}

// Close all DB handles on worker exit
process.on('exit', () => {
  if (currentDb) safeClose(currentDb)
  for (const db of dbCache.values()) safeClose(db)
  dbCache.clear()
})


/**------------------------- Exports ------------------------*/

module.exports = {
  searchOne, applyFtsPragmas,
  getPool, destroyPool, isPoolActive, getPoolStats,
  ensureDb
}
