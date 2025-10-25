/** Given a raw title, match it to a book in the database.
 * */

const { normalizeTitle } = require('./normalizer.js')
const Fuse = require('fuse.js')
const os = require('os')
const Database = require('better-sqlite3')

const Piscina = require('piscina')

const {
  DEFAULTS, DEFAULT_FUSE_OPTS, DECISION, REASONS
} = require('./config.js')
const e = require('express')

/** ------------------------ Main ------------------------ */
function searchOne(db, title_raw, options = {}) {
  // return the id of the best match
  const CFG = { ...DEFAULTS, ...options }
  const stmts = prepareStatements(db, CFG)
  const norms = normalizeTitle(title_raw)
  // Stage A — exact

  const res = exactMatch(stmts, norms, CFG)
  // console.log("exact match", res)
  // console.log('res', res)
  if (res.decision === DECISION.exact) return res

  // Stage B — FTS only [{gid, bm25}... ]
  const candidates = filterCandidatesFTS(stmts, norms, CFG)
  // console.log('candidates', candidates)
  // console.log("candidates match", candidates)

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
  const {
    TABLE_TCI, TABLE_FTS, COL_ID, COL_FULL, COL_CORE, LIMIT_FULL, LIMIT_CORE,
  } = CFG

  // One normalized language predicate we’ll inject into the “_lang” statements.
  // If you create idx_gallery_langflag (expression index), SQLite can use it.
  const LANG_OK_CASE = `
    (CASE
       WHEN g.language IS NULL OR g.language='' THEN 1
       WHEN instr(lower(g.language),'japanese')>0 THEN 1
       WHEN instr(lower(g.language),'chinese') >0 THEN 1
       ELSE 0
     END) = 1
  `

  // ---------- Stage A: exact lookups ----------
  const exactFull_noLang = db.prepare(`
      SELECT t.${COL_ID} AS gid
      FROM ${TABLE_TCI} AS t
               JOIN gallery AS g ON g.gid = t.${COL_ID}
      WHERE t.${COL_FULL} = ?
      LIMIT ?;
  `)

  const exactFull_lang = db.prepare(`
      SELECT t.${COL_ID} AS gid
      FROM ${TABLE_TCI} AS t
               JOIN gallery AS g ON g.gid = t.${COL_ID}
      WHERE t.${COL_FULL} = ?
        AND ${LANG_OK_CASE}
      LIMIT ?;
  `)

  const exactCore_noLang = db.prepare(`
      SELECT t.${COL_ID} AS gid
      FROM ${TABLE_TCI} AS t
               JOIN gallery AS g ON g.gid = t.${COL_ID}
      WHERE t.${COL_CORE} = ?
      LIMIT ?;
  `)

  const exactCore_lang = db.prepare(`
      SELECT t.${COL_ID} AS gid
      FROM ${TABLE_TCI} AS t
               JOIN gallery AS g ON g.gid = t.${COL_ID}
      WHERE t.${COL_CORE} = ?
        AND ${LANG_OK_CASE}
      LIMIT ?;
  `)

  // ---------- Stage B: FTS5 ----------
  // NOTE: rowid of FTS table must equal t.tci_id (content_rowid). Adjust if named differently.
  const fts_noLang = db.prepare(`
      SELECT t.${COL_ID}        AS gid,
             bm25(${TABLE_FTS}) AS bm25
      FROM ${TABLE_FTS}
               JOIN ${TABLE_TCI} AS t ON t.tci_id = ${TABLE_FTS}.rowid
               JOIN gallery AS g ON g.gid = t.${COL_ID}
      WHERE ${TABLE_FTS} MATCH ?
      ORDER BY bm25(${TABLE_FTS}) ASC
      LIMIT ?;
  `)

  const fts_lang = db.prepare(`
      SELECT t.${COL_ID}        AS gid,
             bm25(${TABLE_FTS}) AS bm25
      FROM ${TABLE_FTS}
               JOIN ${TABLE_TCI} AS t ON t.tci_id = ${TABLE_FTS}.rowid
               JOIN gallery AS g ON g.gid = t.${COL_ID}
      WHERE ${TABLE_FTS} MATCH ?
        AND ${LANG_OK_CASE}
      ORDER BY bm25(${TABLE_FTS}) ASC
      LIMIT ?;
  `)

  // ---------- Shard builders ----------
  // Use EXISTS for language to avoid row blow-up.
  const shardByVol_noLang = db.prepare(`
      SELECT DISTINCT m.gid AS gid
      FROM tci_title_meta AS m
               LEFT JOIN tci_vol_range AS tvr ON tvr.gid = m.gid
      WHERE (m.vol_num = ? OR (tvr.v_from <= ? AND tvr.v_to >= ?));
  `)

  const shardByVol_lang = db.prepare(`
      SELECT DISTINCT m.gid AS gid
      FROM tci_title_meta AS m
               LEFT JOIN tci_vol_range AS tvr ON tvr.gid = m.gid
      WHERE (m.vol_num = ? OR (tvr.v_from <= ? AND tvr.v_to >= ?))
        AND EXISTS (SELECT 1
                    FROM gallery g
                    WHERE g.gid = m.gid
                      AND ${LANG_OK_CASE});
  `)

  const shardByRange_noLang = db.prepare(`
      SELECT DISTINCT tvr.gid AS gid
      FROM tci_vol_range AS tvr
      WHERE tvr.v_from <= ?
        AND tvr.v_to >= ?;
  `)

  const shardByRange_lang = db.prepare(`
      SELECT DISTINCT tvr.gid AS gid
      FROM tci_vol_range AS tvr
      WHERE tvr.v_from <= ?
        AND tvr.v_to >= ?
        AND EXISTS (SELECT 1
                    FROM gallery g
                    WHERE g.gid = tvr.gid
                      AND ${LANG_OK_CASE});
  `)

  const shardByNum1_noLang = db.prepare(`
      SELECT DISTINCT tt.gid AS gid
      FROM tci_title_tokens AS tt
      WHERE tt.n = ?;
  `)

  const shardByNum1_lang = db.prepare(`
      SELECT DISTINCT tt.gid AS gid
      FROM tci_title_tokens AS tt
      WHERE tt.n = ?
        AND EXISTS (SELECT 1
                    FROM gallery g
                    WHERE g.gid = tt.gid
                      AND ${LANG_OK_CASE});
  `)

  const shardByNum2_noLang = db.prepare(`
      SELECT tt.gid AS gid
      FROM tci_title_tokens AS tt
      WHERE tt.n IN (?, ?)
      GROUP BY tt.gid
      HAVING COUNT(DISTINCT tt.n) = 2;
  `)

  const shardByNum2_lang = db.prepare(`
      SELECT tt.gid AS gid
      FROM tci_title_tokens AS tt
      WHERE tt.n IN (?, ?)
        AND EXISTS (SELECT 1
                    FROM gallery g
                    WHERE g.gid = tt.gid
                      AND ${LANG_OK_CASE})
      GROUP BY tt.gid
      HAVING COUNT(DISTINCT tt.n) = 2;
  `)

  // ---------- Titles fetch for fuzzy post-filter ----------
  // Keep it simple: we still LEFT JOIN to get language in the payload.
  // We’ll filter by lang (when on) using the same CASE predicate.
  function _getTitles_stmt(gids, langFlag) {
    if (!gids.length) return { all: () => [] }
    const placeholders = gids.map(() => '?').join(',')
    const pre = `SELECT t.${COL_ID}   AS gid,
                        t.${COL_FULL} AS title_full_norm,
                        t.${COL_CORE} AS title_core_norm,
                        g.language    AS language
                 FROM ${TABLE_TCI} AS t
                          LEFT JOIN gallery AS g ON g.gid = t.${COL_ID}
                 WHERE t.${COL_ID} IN (${placeholders})
    `
    if (langFlag) {
      return db.prepare(pre + `AND ${LANG_OK_CASE}`)
    } else {
      return db.prepare(pre)
    }
  }

  // ---------- Thin wrappers to preserve your call style ----------
  const exactFull = {
    all: (titleFull, langFlag) =>
        (langFlag ? exactFull_lang : exactFull_noLang).all(titleFull, LIMIT_FULL)
  }

  const exactCore = {
    all: (titleCore, langFlag) =>
        (langFlag ? exactCore_lang : exactCore_noLang).all(titleCore, LIMIT_CORE)
  }

  const ftsQuery = {
    all: (ftsQueryText, langFlag, topN) =>
        (langFlag ? fts_lang : fts_noLang).all(ftsQueryText, Number.isFinite(topN) ? topN : CFG.FTS_TOPN)
  }

  const shardByVol = {
    all: (v, langFlag) =>
        (langFlag ? shardByVol_lang : shardByVol_noLang).all(v, v, v)
  }

  const shardByRange = {
    all: (vFrom, vTo, langFlag) =>
        (langFlag ? shardByRange_lang : shardByRange_noLang).all(vFrom, vTo)
  }

  const shardByNum1 = {
    all: (n, langFlag) =>
        (langFlag ? shardByNum1_lang : shardByNum1_noLang).all(n)
  }

  const shardByNum2 = {
    all: (n1, n2, langFlag) =>
        (langFlag ? shardByNum2_lang : shardByNum2_noLang).all(n1, n2)
  }

  const getTitles = (gids, langFlag) => {
    const stmt = _getTitles_stmt(gids, !!langFlag)
    return stmt.all(...gids)
  }

  return {
    exactFull,
    exactCore,
    ftsQuery,
    shardByVol,
    shardByRange,
    shardByNum1,
    shardByNum2,
    getTitles,
    _db: db
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
function exactMatch(stmts, norms, CFG = DEFAULTS) {
  const langFlag = CFG.JP_ZH_ONLY ? 1 : 0

  if (norms.title_full_norm) {
    const fullHits = stmts.exactFull.all(norms.title_full_norm, langFlag)
    if (fullHits.length === 1) {
      return {
        decision: DECISION.exact,
        reason: REASONS.exact_full,
        matched: { gid: fullHits[0].gid, score: 0 },
        diagnostics: { norms }
      }
    } else if (fullHits.length > 1) {
      return {
        decision: DECISION.review,
        reason: REASONS.exact_full_collision,
        matched: { gid: fullHits[0].gid, score: 0 }, // 0 is the best score
        diagnostics: { norms }
      }
    }
  }

  if (norms.title_core_norm) {
    const coreHits = stmts.exactCore.all(norms.title_core_norm, langFlag)
    if (coreHits.length === 1) {
      return {
        decision: DECISION.exact,
        reason: REASONS.exact_core,
        matched: { gid: coreHits[0].gid, score: 0 },
        diagnostics: { norms }
      }
    } else if (coreHits.length > 1) {
      return {
        decision: DECISION.review,
        reason: REASONS.exact_core_collision,
        matched: { gid: coreHits[0].gid, score: 0 },
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
/**
 * Stage B: Build a gid shard (vol/series/numbers), then run FTS within that shard.
 * Returns [{ gid, bm25 }] sorted by bm25 asc, capped to CFG.FTS_TOPN.
 */

function _____filterCandidatesFTS(stmts, norms, CFG = DEFAULTS) {
  const queries = buildFtsQueries(norms)
  if (!queries.length) return []

  const langFlag = CFG.JP_ZH_ONLY ? 1 : 0

  // ---------------- 1) FTS first: collect best bm25 per gid ----------------
  const bestById = new Map() // gid -> { gid, bm25 }

  for (const q of queries) {
    // Bind: (matchQuery, jpZhOnlyFlag, limit)
    const rows = stmts.ftsQuery.all(q, langFlag, CFG.FTS_TOPN)
    for (const r of rows) {
      // take the intersection of the allowed gids and the FTS hits
      const cur = bestById.get(r.gid)
      if (!cur || r.bm25 < cur.bm25) bestById.set(r.gid, r)
    }
    // Early stop once we have plenty to feed Fuse
    if (bestById.size >= CFG.FTS_TOPN * 4) break
  }


  const ranked = Array.from(bestById.values()).sort((a, b) => a.bm25 - b.bm25)
  return ranked.slice(0, CFG.FTS_TOPN)
}

function filterCandidatesFTS(stmts, norms, CFG = DEFAULTS) {
  const queries = buildFtsQueries(norms)
  if (!queries.length) return []

  const langFlag = CFG.JP_ZH_ONLY ? 1 : 0

  // ---------------- 1) FTS first: collect best bm25 per gid ----------------
  const bestById = new Map() // gid -> { gid, bm25 }
  for (const q of queries) {
    const rows = stmts.ftsQuery.all(q, langFlag, CFG.FTS_TOPN) // (matchQuery, jpZhOnlyFlag, limit)
    for (const r of rows) {
      const cur = bestById.get(r.gid)
      if (!cur || r.bm25 < cur.bm25) bestById.set(r.gid, r)
    }
    if (bestById.size >= CFG.FTS_TOPN * 4) break // enough to feed Fuse later
  }
  if (bestById.size === 0) return []

  // Universe we will ever consider henceforth
  const ftsGidsArr = Array.from(bestById.keys())

  // Helpers — SQL-scoped (preferred) vs JS-intersect (fallback)
  const db = stmts._db

  const valuesCTE = (vals) => {
    // Build "(VALUES (?),(?),(?))" and params
    const ph = vals.map(() => '(?)').join(',')
    return { sql: `VALUES ${ph}`, params: vals }
  }

  const shardVolInFts = (vFrom, vTo, singleV) => {
    // DB-scoped: restrict to FTS ids via CTE
    const { sql, params } = valuesCTE(ftsGidsArr)
    if (singleV != null) {
      const q = db.prepare(`
          WITH fts_ids(gid) AS (${sql})
          SELECT DISTINCT fi.gid
          FROM fts_ids fi
                   LEFT JOIN tci_title_meta m ON m.gid = fi.gid
                   LEFT JOIN tci_vol_range tvr ON tvr.gid = fi.gid
                   JOIN gallery g ON g.gid = fi.gid
          WHERE (m.vol_num = ? OR (tvr.v_from <= ? AND tvr.v_to >= ?))
            AND (? = 0
              OR g.language IS NULL OR g.language = ''
              OR INSTR(LOWER(g.language), 'japanese') > 0
              OR INSTR(LOWER(g.language), 'chinese') > 0)
      `)
      const rs = q.all(...params, singleV, singleV, singleV, langFlag)
      return new Set(rs.map(r => r.gid))
    } else {
      const q = db.prepare(`
          WITH fts_ids(gid) AS (${sql})
          SELECT DISTINCT fi.gid
          FROM fts_ids fi
                   JOIN tci_vol_range tvr ON tvr.gid = fi.gid
                   JOIN gallery g ON g.gid = fi.gid
          WHERE tvr.v_from <= ?
            AND tvr.v_to >= ?
            AND (? = 0
              OR g.language IS NULL OR g.language = ''
              OR INSTR(LOWER(g.language), 'japanese') > 0
              OR INSTR(LOWER(g.language), 'chinese') > 0)
      `)
      const rs = q.all(...params, vFrom, vTo, langFlag)
      return new Set(rs.map(r => r.gid))
    }
  }

  const shardNumInFts = (n1, n2 = null) => {
    const { sql, params } = valuesCTE(ftsGidsArr)
    if (n2 == null) {
      const q = db.prepare(`
          WITH fts_ids(gid) AS (${sql})
          SELECT DISTINCT fi.gid
          FROM fts_ids fi
                   JOIN tci_title_tokens tt ON tt.gid = fi.gid
                   JOIN gallery g ON g.gid = fi.gid
          WHERE tt.n = ?
            AND (? = 0
              OR g.language IS NULL OR g.language = ''
              OR INSTR(LOWER(g.language), 'japanese') > 0
              OR INSTR(LOWER(g.language), 'chinese') > 0)
      `)
      const rs = q.all(...params, n1, langFlag)
      return new Set(rs.map(r => r.gid))
    } else {
      const q = db.prepare(`
          WITH fts_ids(gid) AS (${sql})
          SELECT fi.gid
          FROM fts_ids fi
                   JOIN tci_title_tokens tt ON tt.gid = fi.gid
                   JOIN gallery g ON g.gid = fi.gid
          WHERE tt.n IN (?, ?)
            AND (? = 0
              OR g.language IS NULL OR g.language = ''
              OR INSTR(LOWER(g.language), 'japanese') > 0
              OR INSTR(LOWER(g.language), 'chinese') > 0)
          GROUP BY fi.gid
          HAVING COUNT(DISTINCT tt.n) = 2
      `)
      const rs = q.all(...params, n1, n2, langFlag)
      return new Set(rs.map(r => r.gid))
    }
  }

  // ---------------- 2) Build post-filters LIMITED to FTS gids ----------------
  let volAllow = null
  if (Array.isArray(norms.vol_set) && norms.vol_set.length >= 2) {
    const minV = Math.min(...norms.vol_set)
    const maxV = Math.max(...norms.vol_set)
    if (Number.isFinite(minV) && Number.isFinite(maxV) && minV <= maxV) {
      volAllow = shardVolInFts(minV, maxV, null)
    }
  } else if (Number.isFinite(norms.vol_num) && norms.vol_conf >= 1) {
    const v = norms.vol_num | 0
    volAllow = shardVolInFts(null, null, v)
  }

  let reqNums = Array.isArray(norms.nums_required) ? norms.nums_required.slice(0, 2) : []
  let numAllow = null
  if (reqNums.length === 2) {
    numAllow = shardNumInFts(reqNums[0], reqNums[1])
  } else if (reqNums.length === 1) {
    numAllow = shardNumInFts(reqNums[0], null)
  }

  const combineAllow = (a, b) => {
    if (a && b) {
      const out = new Set()
      for (const x of a) if (b.has(x)) out.add(x)
      return out
    }
    return a || b || null
  }

  let allow = combineAllow(volAllow, numAllow)

  // ---------------- 3) Apply allow strictly inside FTS universe ----------------
  const applyAllowToFts = (allowSet) => {
    if (!allowSet) return Array.from(bestById.values())
    const out = []
    for (const r of bestById.values()) if (allowSet.has(r.gid)) out.push(r)
    return out
  }

  let filtered = applyAllowToFts(allow)

  // ---------------- 4) Relaxation if too small ----------------
  const need = CFG.FTS_TOPN
  const tooSmall = () => filtered.length < need

  // 4a) Medium-conf single volume → try ±1 (still limited to FTS gids)
  if (tooSmall() && norms.vol_conf === 1 && Number.isFinite(norms.vol_num)) {
    const v = norms.vol_num | 0
    const setEq = shardVolInFts(null, null, v)
    const setM1 = shardVolInFts(null, null, v - 1)
    const setP1 = shardVolInFts(null, null, v + 1)
    const expandedVol = new Set([...setEq, ...setM1, ...setP1])
    allow = combineAllow(expandedVol, numAllow)
    filtered = applyAllowToFts(allow)
  }

  // 4b) Two numerals → relax to one numeral (still FTS-limited)
  if (tooSmall() && reqNums.length === 2) {
    reqNums = reqNums.slice(0, 1)
    numAllow = shardNumInFts(reqNums[0], null)
    allow = combineAllow(volAllow, numAllow)
    filtered = applyAllowToFts(allow)
  }

  // 4c) Still too small → drop numerals; keep volume/range only (FTS-limited)
  if (tooSmall() && numAllow) {
    allow = volAllow || null
    filtered = applyAllowToFts(allow)
  }

  // 4d) Still too small → drop all shards (pure FTS among FTS-selected)
  if (tooSmall() && allow) {
    allow = null
    filtered = applyAllowToFts(null)
  }

  // ---------------- 5) Rank by bm25 and cap ----------------
  filtered.sort((a, b) => a.bm25 - b.bm25)
  return filtered.slice(0, CFG.FTS_TOPN)
}

function _filterCandidatesFTS(stmts, norms, CFG = DEFAULTS) {
  const queries = buildFtsQueries(norms)
  if (!queries.length) return []

  const langFlag = CFG.JP_ZH_ONLY ? 1 : 0

  // ---------------- Shard building (cheap blockers) ----------------
  let hasShard = false
  let shard = null // Set<gid>

  // 1) Volume-based shard
  if (Array.isArray(norms.vol_set) && norms.vol_set.length >= 2) {
    // Omnibus input: require containment of the whole [min..max] span
    const minV = Math.min(...norms.vol_set)
    const maxV = Math.max(...norms.vol_set)
    if (Number.isFinite(minV) && Number.isFinite(maxV) && minV <= maxV) {
      const rows = stmts.shardByRange.all(minV, maxV, langFlag)
      const gids = new Set(rows.map(r => r.gid))
      if (gids.size > 0) {
        shard = gids
        hasShard = true
      }
    }
  } else if (Number.isFinite(norms.vol_num) && norms.vol_conf >= 1) {
    // Single-volume input: prefer exact vol_num, allow fallback to omnibus containing v
    const v = norms.vol_num | 0
    const rows = stmts.shardByVol.all(v, v, v, langFlag) // (m.vol_num = v) OR (tvr contains v)
    const gids = new Set(rows.map(r => r.gid))
    if (gids.size > 0) {
      shard = gids
      hasShard = true
    }
  }

  // 2) Informative numerals presence (require 1–2 rare numerals)
  const reqNums = Array.isArray(norms.nums_required)
      ? norms.nums_required.slice(0, 2)
      : []

  if (reqNums.length === 2) {
    const rows = stmts.shardByNum2.all(reqNums[0], reqNums[1], langFlag)
    const gids = new Set(rows.map(r => r.gid))
    if (hasShard) {
      const next = new Set()
      for (const g of gids) if (shard.has(g)) next.add(g)
      shard = next
    } else {
      shard = gids
      hasShard = true
    }
    // Relaxation: if too small, drop to the rarer 1 numeral (upstream should have ordered by rarity)
    if ((shard?.size || 0) < CFG.MIN_SHARD) reqNums.splice(1, 1)
  }

  if (reqNums.length === 1) {
    const rows = stmts.shardByNum1.all(reqNums[0], langFlag)
    const gids = new Set(rows.map(r => r.gid))
    if (hasShard) {
      const next = new Set()
      for (const g of gids) if (shard.has(g)) next.add(g)
      shard = next
    } else {
      shard = gids
      hasShard = true
    }
  }

  // 3) Relaxation for medium-conf single volume: include ±1 if shard is still small
  if ((shard?.size || 0) < CFG.MIN_SHARD && norms.vol_conf === 1 && Number.isFinite(norms.vol_num)) {
    const v = norms.vol_num | 0
    const rowsEq = stmts.shardByVol.all(v, v, v, langFlag)
    const rowsM1 = stmts.shardByVol.all(v - 1, v - 1, v - 1, langFlag)
    const rowsP1 = stmts.shardByVol.all(v + 1, v + 1, v + 1, langFlag)
    const gids = new Set([...rowsEq, ...rowsM1, ...rowsP1].map(r => r.gid))
    if (hasShard) {
      const next = new Set()
      for (const g of gids) if (shard.has(g)) next.add(g)
      shard = next
    } else {
      shard = gids
      hasShard = true
    }
  }

  // If no shard (or empty), allow all (FTS will still be language-filtered)
  const allow = hasShard ? shard : null
  // ---------------- Run FTS queries and keep best bm25 per gid ----------------
  const bestById = new Map()

  for (const q of queries) {
    // Bind: (matchQuery, jpZhOnlyFlag, limit)
    const rows = stmts.ftsQuery.all(q, langFlag, CFG.FTS_TOPN)
    for (const r of rows) {
      // take the intersection of the allowed gids and the FTS hits
      if (allow && !allow.has(r.gid)) continue
      const cur = bestById.get(r.gid)
      if (!cur || r.bm25 < cur.bm25) bestById.set(r.gid, r)
    }
    // Early stop once we have plenty to feed Fuse
    if (bestById.size >= CFG.FTS_TOPN * 4) break
  }
  // Optional safety: enforce required numerals even if allow=null (redundant but safe)
  if (CFG.DROP_ON_MISSING_REQUIRED_NUMS && reqNums.length > 0 && !allow) {
    if (reqNums.length === 2) {
      const rows = stmts.shardByNum2.all(reqNums[0], reqNums[1], langFlag)
      const ok = new Set(rows.map(r => r.gid))
      for (const gid of Array.from(bestById.keys())) if (!ok.has(gid)) bestById.delete(gid)
    } else if (reqNums.length === 1) {
      const rows = stmts.shardByNum1.all(reqNums[0], langFlag)
      const ok = new Set(rows.map(r => r.gid))
      for (const gid of Array.from(bestById.keys())) if (!ok.has(gid)) bestById.delete(gid)
    }
  }

  const ranked = Array.from(bestById.values()).sort((a, b) => a.bm25 - b.bm25)
  return ranked.slice(0, CFG.FTS_TOPN)
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
      matched: { gid: ranked[0].gid, score: 1 }, // highest score to avoid this result
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
      matched: { gid: ranked[0].gid, score: 1 },
      diagnostics: { norms }
    }
  } else {
    const top = results[0]
    // .map(r => ({ ...r, adjustedScore: adjustScoreByLanguage(r) }))
    // .sort((a, b) => a.adjustedScore - b.adjustedScore)[0]  // top-1

    // const score = typeof top.score === 'number' ? top.score : 1
    return {
      decision: DECISION.review,
      reason: REASONS.fuzzy_rank,
      matched: { gid: top.item.gid, score: top.score },
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

function getPool({ filename, poolSize, createNew = true } = {}) {
  if (createNew === false && !pool) throw new Error('no pool')
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
