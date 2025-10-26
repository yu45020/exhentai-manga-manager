const { normalizeTitle } = require('./normalizer')
const { NORM_VERSION } = require('./config.js')
const JSON5 = require('json5')
// TODO: rewrite using node-sqlite3 ?
// -------------------- Main --------------------

/**
 * The db must be 'api_dump.sqlite' or similar.
 * The first run creates the title_core_index table and FTS index for matching titles.
 *   Strings in the `title`, `title_jpn`, and `torrents[name]` columns are normalized.
 * Later runs will only backfill new gids that are updated/inserted in the gallery table.
 * We track the norm version. If it changes, we rebuild tables.
 * */
function initTitleCoreIndex(db) {
  db.pragma('journal_mode = WAL')
  db.exec('BEGIN')
  try {
    ensureVersionTable(db)
    ensureGalleryIndex(db)
    ensureQueueTable(db)               // queue table to track new/updated gids
    createGalleryEnqueueTriggers(db)   // gallery → queue triggers: insert, update
    const current = getNormVersion(db)           // may be null on first run
    const hasTCI = tableExists(db, 'title_core_index')
    const needsRebuild = current === null || current !== NORM_VERSION
    const totalRows = countTotalGids(db)

    if (needsRebuild) {
      console.log(`TitleCoreIndex: norm version mismatch. Current version ${current}. Expected version ${NORM_VERSION} Rebuilding from scratch.`)
      // Norm version changed (or first run without a recorded version) → full rebuild
      dropIndexAndFts(db)
      createIndexTable(db)
      populateAllFromGallery(db, totalRows)
      createIndexes(db)
      createOrRebuildFts(db, /*fresh=*/true)
      setNormVersion(db, NORM_VERSION)
      db.exec(`DELETE
               FROM tci_new_gid;`)
      db.exec('COMMIT')
      console.log('Full rebuild of title_core_index and FTS.')
      return
    }

    // Versions match:
    if (!hasTCI) {
      console.log('TitleCoreIndex: no title_core_index table found; creating one.')
      // Build missing table then populate everything
      createIndexTable(db)
      populateAllFromGallery(db, totalRows)
      createOrRebuildFts(db, /*fresh=*/true)
      db.exec('COMMIT')
      console.log('Created title_core_index and FTS.')
      return
    }

    // Version matches and tables exist → only backfill new gids

    const numNew = countNewGids(db)
    if (numNew > 0) {
      console.log('Found ' + numNew + ' new gids. Backfilling.')
      insertMissingFromGallery(db, numNew)
      // FTS is content-backed with triggers; still issue a rebuild if the table was empty before
      ensureFtsAndTriggers(db)
      db.exec('COMMIT')
      console.log('Backfilled missing gids.')
      return
    }

    // Nothing to do
    ensureFtsAndTriggers(db) // make sure FTS infra exists even if no inserts were needed
    db.exec('COMMIT')
    console.log('Tables and triggers already up-to-date. Nothing to do.')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

function isDBInited(db) {
  function tableExists(db, name) {
    const row = db.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ?
        LIMIT 1
    `).get(name)
    return !!row
  }

  function indexExists(db, name) {
    const row = db.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'index'
          AND name = ?
        LIMIT 1
    `).get(name)
    return !!row
  }

  // For virtual tables (FTS5), PRAGMA table_info works, but we also sanity-check the CREATE SQL.
  function ftsHasColumn(db, table, col) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
      if (cols.includes(col)) return true
      const sql = db.prepare(`
          SELECT sql
          FROM sqlite_master
          WHERE type = 'table'
            AND name = ?
          LIMIT 1
      `).get(table)?.sql || ''
      return /\btitle_core_norm_seg\b/i.test(sql)
    } catch {
      return false
    }
  }

  function hasColumns(db, table, expected) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    return expected.every(c => cols.includes(c))
  }

  // 1) Norm version table and match
  if (!tableExists(db, 'title_core_norm_version')) return false
  if (getNormVersion(db) !== NORM_VERSION) return false

  // 2) Core variant table present with expected columns
  if (!tableExists(db, 'title_core_index')) return false
  if (!hasColumns(db, 'title_core_index', [
    'tci_id', 'gid', 'title_full_norm', 'title_core_norm', 'title_core_norm_seg'
  ])) return false

  // 3) Prefiltering tables (split: meta / tokens) + omnibus range

  if (!tableExists(db, 'tci_title_tokens')) return false
  if (!hasColumns(db, 'tci_title_tokens', ['tci_id', 'gid', 'n'])) return false

  // 4) FTS exists and has the expected segment column
  if (!tableExists(db, 'tci_fts')) return false
  if (!ftsHasColumn(db, 'tci_fts', 'title_core_norm_seg')) return false

  // 5) Critical indexes present
  if (!indexExists(db, 'uniq_tci_gid_title')) return false // on title_core_index(gid, title_full_norm)
  if (!indexExists(db, 'idx_ttt_n')) return false          // inverted index on tokens(n)

  // Optional but nice-to-have (don’t fail init if missing):
  // if (!indexExists(db, 'idx_tci_gid')) { /* warn if you want */ }
  // if (!indexExists(db, 'idx_ttt_gid')) { /* warn if you want */ }
  // if (!indexExists(db, 'idx_tvr_gid')) { /* warn if you want */ }

  return true
}


/* ------------------------ helpers ------------------------ */

function tableExists(db, name) {
  return !!db.prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name = ?`
  ).get(name)
}

function ensureVersionTable(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS title_core_norm_version
      (
          version INTEGER NOT NULL
      );
  `)
  // keep exactly 0 or 1 row. If multiple rows ever appear, squash to max(version)
  const cnt = db.prepare(`SELECT COUNT(*) AS c
                          FROM title_core_norm_version`).get().c
  if (cnt > 1) {
    const maxv = db.prepare(`SELECT MAX(version) AS v
                             FROM title_core_norm_version`).get().v
    db.exec(`DELETE
             FROM title_core_norm_version;`)
    db.prepare(`INSERT INTO title_core_norm_version(version)
                VALUES (?)`).run(maxv ?? 0)
  }
}

function getNormVersion(db) {
  const row = db.prepare(`SELECT version
                          FROM title_core_norm_version
                          LIMIT 1`).get()
  return row ? row.version : null
}

function setNormVersion(db, v) {
  const row = db.prepare(`SELECT version
                          FROM title_core_norm_version
                          LIMIT 1`).get()
  if (!row) {
    db.prepare(`INSERT INTO title_core_norm_version(version)
                VALUES (?)`).run(v)
  } else {
    db.prepare(`UPDATE title_core_norm_version
                SET version = ?`).run(v)
  }
}

function dropIndexAndFts(db) {
  // 0) Drop FTS maintenance triggers first (safe even if table is gone)
  db.exec(`
    DROP TRIGGER IF EXISTS tci_ai;
    DROP TRIGGER IF EXISTS tci_au;
    DROP TRIGGER IF EXISTS tci_ad;
    DROP TRIGGER IF EXISTS tci_aux_cleanup_del;
    DROP TRIGGER IF EXISTS tci_aux_cleanup_upd;
  `)

  // 1) Drop FTS virtual table (content-backed)
  db.exec(`DROP TABLE IF EXISTS tci_fts;`)

  // 2) Drop aux tables from the current design
  db.exec(`
      DROP TABLE IF EXISTS tci_title_tokens;
  `)

  // 3) Drop the core variant table last (this implicitly drops any triggers bound to it)
  db.exec(`DROP TABLE IF EXISTS title_core_index;`)

  // NOTE: Do NOT drop gallery, tci_new_gid, or the norm/version table.
}


function createIndexTable(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS title_core_index
      (
          tci_id              INTEGER PRIMARY KEY, -- stable per-variant id
          gid                 INTEGER NOT NULL,    -- gallery id
          title_full_norm     TEXT    NOT NULL,
          title_core_norm     TEXT    NOT NULL,
          title_core_norm_seg TEXT    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_tci_gid_title
          ON title_core_index (title_full_norm, gid);
      --- Per-title-variant index with a stable integer PK

      -- One row per distinct numeric token present in the title text, n can be a range, say vol. 1-3 --> "1-3"
      CREATE TABLE IF NOT EXISTS tci_title_tokens
      (
          tci_id INTEGER NOT NULL,
          gid    INTEGER NOT NULL,
          n      TEXT NOT NULL,
          PRIMARY KEY (tci_id, n)
      ) WITHOUT ROWID;
  `)
}


function createIndexes(db) {
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tci_gid
          ON title_core_index (gid);
      CREATE INDEX IF NOT EXISTS idx_tci_title_core
          ON title_core_index (title_core_norm, gid);
      CREATE INDEX IF NOT EXISTS uniq_tci_title
          ON title_core_index (title_full_norm, gid);


      CREATE INDEX IF NOT EXISTS idx_ttt_gid
          ON tci_title_tokens (gid);
      CREATE INDEX IF NOT EXISTS idx_ttt_n
          ON tci_title_tokens (gid, n);
  `)
}

function countTotalGids(db) {
  const row = db.prepare(`
      SELECT COUNT(*) AS c
      FROM gallery
  `).get()
  return row.c | 0
}

function countNewGids(db) {
  const row = db.prepare(`
      SELECT COUNT(*) AS c
      FROM tci_new_gid
  `).get()
  return row.c | 0
}

/* ------------------------ paged build ------------------------ */
/**
 * Populate the entire index from gallery (first build or full rebuild).
 * Returns number of inserted rows.
 */
function populateAllFromGallery(db, totalRows) {
  const selectPage = db.prepare(`
      SELECT g.gid, g.title, g.title_jpn, g.torrents
      FROM gallery AS g
      WHERE (@last IS NULL OR g.gid > @last)
        AND g.gid IS NOT NULL
      ORDER BY g.gid
      LIMIT @limit
  `)
  insertFromGallery(db, selectPage, totalRows)
}

/**
 * Insert only the missing gids into title_core_index.
 * Returns number of inserted rows.
 */
function insertMissingFromGallery(db, totalRows) {
  // Page strictly by queue rowid so range deletes are correct
  const selectPage = db.prepare(`
      SELECT q.rowid, q.gid, g.title, g.title_jpn, g.torrents
      FROM tci_new_gid AS q
               JOIN gallery AS g ON g.gid = q.gid
      WHERE (@last IS NULL OR q.rowid > @last)
      ORDER BY q.rowid
      LIMIT @limit
  `)

  // Fast range delete over the rowid window we just processed
  const delQueueRange = db.prepare(`
      DELETE
      FROM tci_new_gid
      WHERE rowid >= ?
        AND rowid <= ?
  `)

  insertFromGallery(db, selectPage, totalRows, { delQueueRange })

  // Clean up any stale queue entries whose gallery row disappeared
  db.exec(`
      DELETE
      FROM tci_new_gid
      WHERE NOT EXISTS (SELECT 1 FROM gallery WHERE gallery.gid = tci_new_gid.gid)
  `)
}


function insertFromGallery(db, query, totalRows, opts = {}) {
  const { delQueueRange = null, pageSize = 10000 } = opts

  // 1) base variant insert
  const insertContent = db.prepare(`
      INSERT OR IGNORE INTO title_core_index
          (gid, title_full_norm, title_core_norm, title_core_norm_seg)
      VALUES (?, ?, ?, ?)
  `)

  // 2) fetch tci_id for a newly (or previously) inserted variant
  const selectTciId = db.prepare(`
      SELECT tci_id
      FROM title_core_index
      WHERE gid = ?
        AND title_full_norm = ?
  `)

  // 4) per-variant numeric tokens (one row per distinct n)
  const insertToken = db.prepare(`
      INSERT OR IGNORE INTO tci_title_tokens
          (tci_id, gid, n)
      VALUES (?, ?, ?)
  `)


  const insertPageTxn = db.transaction((rows) => {
    for (const row of rows) {
      const candidates = getTitleCandidates(row) // e.g., title_jpn, title, torrent names
      for (const raw of candidates) {
        const n = normalizeTitle(raw)

        // (A) insert / ensure variant
        insertContent.run(
            row.gid,
            n.title_full_norm,
            n.title_core_norm,
            n.title_core_norm_seg
        )

        // (B) fetch tci_id for this (gid, title_full_norm)
        const rec = selectTciId.get(row.gid, n.title_full_norm)
        if (!rec) continue
        const tci_id = rec.tci_id


        // (D) tokens (distinct)
        let nums = Array.isArray(n?.nums_all) ? new Set(n.nums_all) : null
        for (const val of nums) {
          insertToken.run(tci_id, row.gid, val)
        }

      }
    }
  })

  let last = 0 // gid is positive
  let processed = 0
  while (true) {
    // 1) page the source rows
    const rows = query.all({ last, limit: pageSize })
    if (!rows || rows.length === 0) break

    // 2) load this page atomically
    insertPageTxn(rows)

    // 3) advance keyset + housekeeping
    last = rows[rows.length - 1].gid
    processed += rows.length

    if (delQueueRange) {
      const firstRowid = rows[0].rowid
      const lastRowid = rows[rows.length - 1].rowid
      delQueueRange.run(firstRowid, lastRowid)
    }

    if (processed % 100000 === 0) {
      console.log(`Processed ${(processed / totalRows * 100).toFixed(2)}% …`)
    }
  }
}


/** extract file names ("name") from torrents, which is a list of objects with a "name" for file name,
 * but the list if not a valid JSON object.  */
function extractTorrentNamesLoose(s) {
  if (!s) return []
  try {
    const p = JSON5.parse(String(s).replace(/\bNone\b/g, 'null')
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false'))
    const arr = Array.isArray(p) ? p : (p && Array.isArray(p.torrents)) ? p.torrents : []
    return arr
        .map(t => (t?.name || t?.metadata?.name || '').trim())
        .filter(Boolean)
  } catch (e) {
    console.error('Error parsing torrents:', e, 'string:', s)
    return []
  }
}

/** Build the set of candidate raw titles for a row */
function getTitleCandidates(row) {
  const names = new Set()
  if (row.title_jpn) names.add(String(row.title_jpn))
  if (row.title) names.add(String(row.title))
  for (const n of extractTorrentNamesLoose(row.torrents)) {
    names.add(n)
  }
  // Return in a stable order: jp → title → torrents (dedup handled by Set)
  const ordered = []
  if (row.title_jpn) ordered.push(String(row.title_jpn))
  if (row.title) ordered.push(String(row.title))
  for (const n of extractTorrentNamesLoose(row.torrents)) ordered.push(n)
  // Dedupe while preserving the above order
  const out = []
  const seen = new Set()
  for (const s of ordered) {
    const key = s // could downcase/trim if you want stricter dedupe
    if (!seen.has(key)) {
      seen.add(key)
      out.push(s)
    }
  }
  // Also include any names found in the initial Set but not in ordered (unlikely)
  for (const s of names) if (!seen.has(s)) out.push(s)
  return out
}

/* ------------------------ FTS helpers ------------------------ */
/**
 * Ensure FTS exists and is in sync; create triggers to keep it synced.
 * If fresh=true, we can rebuild directly from the content table.
 */
function createOrRebuildFts(db, fresh = false) {
  // Content-backed FTS; rowid mirrors title_core_index.tci_id
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tci_fts USING fts5(
      title_core_norm_seg,
      content='title_core_index',
      content_rowid='tci_id',
      prefix='1 2'
    );
  `)

  // FTS maintenance triggers (only rowid + title_core_norm_seg)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tci_ai
    AFTER INSERT ON title_core_index
    BEGIN
      INSERT INTO tci_fts(rowid, title_core_norm_seg)
      VALUES (new.tci_id, new.title_core_norm_seg);
    END;

    CREATE TRIGGER IF NOT EXISTS tci_au
    AFTER UPDATE OF tci_id, title_core_norm_seg ON title_core_index
    BEGIN
      INSERT INTO tci_fts(tci_fts, rowid, title_core_norm_seg)
      VALUES ('delete', old.tci_id, old.title_core_norm_seg);
      INSERT INTO tci_fts(rowid, title_core_norm_seg)
      VALUES (new.tci_id, new.title_core_norm_seg);
    END;

    CREATE TRIGGER IF NOT EXISTS tci_ad
    AFTER DELETE ON title_core_index
    BEGIN
      INSERT INTO tci_fts(tci_fts, rowid, title_core_norm_seg)
      VALUES ('delete', old.tci_id, old.title_core_norm_seg);
    END;

    -- Aux cleanup (keep as-is; not tied to FTS presence)
    DROP TRIGGER IF EXISTS tci_aux_cleanup_del;
    DROP TRIGGER IF EXISTS tci_aux_cleanup_upd;

    CREATE TRIGGER IF NOT EXISTS tci_aux_cleanup_del
    AFTER DELETE ON title_core_index
    BEGIN
      DELETE FROM tci_title_tokens WHERE tci_id = old.tci_id;
    END;

    CREATE TRIGGER IF NOT EXISTS tci_aux_cleanup_upd
    AFTER UPDATE OF gid, title_full_norm ON title_core_index
    BEGIN
      -- Remove old keys; the insert path will add new rows if needed
      DELETE FROM tci_title_tokens WHERE tci_id = old.tci_id;
    END;
  `)

  if (fresh) {
    db.exec(`INSERT INTO tci_fts(tci_fts)
             VALUES ('rebuild');`)
    return
  }

  // Rebuild if content exists but FTS is empty
  let needRebuild = false
  try {
    const tciCount = (db.prepare(`SELECT COUNT(*) AS c
                                  FROM title_core_index`).get().c | 0)
    const ftsCount = (db.prepare(`SELECT COUNT(*) AS c
                                  FROM tci_fts`).get().c | 0)
    if (tciCount > 0 && ftsCount === 0) needRebuild = true
  } catch (_) { needRebuild = true }
  if (needRebuild) db.exec(`INSERT INTO tci_fts(tci_fts)
                            VALUES ('rebuild');`)
}


function ensureFtsAndTriggers(db) {
  // 0) Ensure base schema exists (safe no-op if already created)
  if (typeof createIndexTable === 'function') {
    createIndexTable(db)
  }

  // 1) Ensure FTS table exists; if not, create and rebuild.
  const hasFts = tableExists(db, 'tci_fts')
  if (!hasFts) {
    createOrRebuildFts(db, /*fresh=*/true)
    console.log('Created FTS table and triggers (fresh rebuild).')
    return
  }

  // 2) Ensure FTS maintenance triggers exist (insert/update/delete).
  const trgNames = ['tci_ai', 'tci_au', 'tci_ad']
  const missing = trgNames.filter(name => {
    const row = db.prepare(
        `SELECT 1
         FROM sqlite_master
         WHERE type = 'trigger'
           AND name = ?
         LIMIT 1`
    ).get(name)
    return !row
  })
  if (missing.length) {
    // Recreate triggers (idempotent) without forcing a rebuild
    createOrRebuildFts(db, /*fresh=*/false)
    console.log(`Reinstalled missing FTS triggers: ${missing.join(', ')}`)
  }

  // 3) Heuristic: content has rows but FTS is empty → rebuild once.
  const tciCount = (db.prepare(`SELECT COUNT(*) AS c
                                FROM title_core_index`).get().c | 0)
  const ftsCount = (db.prepare(`SELECT COUNT(*) AS c
                                FROM tci_fts`).get().c | 0)
  if (tciCount > 0 && ftsCount === 0) {
    db.exec(`INSERT INTO tci_fts(tci_fts)
             VALUES ('rebuild');`)
    console.log('FTS was empty; triggered rebuild from content.')
  }
}


/* ------------------------ Queue + triggers ------------------------ */
function ensureGalleryIndex(db) {
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gallery_gid ON gallery (gid);
      CREATE INDEX IF NOT EXISTS idx_gallery_token ON gallery (token);
      CREATE INDEX IF NOT EXISTS idx_gallery_gid_language ON gallery (gid, language);
      CREATE INDEX IF NOT EXISTS idx_gallery_langflag ON gallery (
                                                                  CASE
                                                                      WHEN language IS NULL OR language = '' THEN 1
                                                                      WHEN instr(lower(language), 'japanese') > 0 THEN 1
                                                                      WHEN instr(lower(language), 'chinese') > 0 THEN 1
                                                                      ELSE 0
                                                                      END
          );

  `)
}

// Deduped queue of gids that need (re)indexing in title_core_index.
function ensureQueueTable(db) {
  // this table stores gids that are updated/inserted in the gallery table
  db.exec(`
      CREATE TABLE IF NOT EXISTS tci_new_gid
      (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,
          gid   INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_tci_new_gid ON tci_new_gid (gid);
  `)
}

// Enqueue on gallery changes: insert; updates to title/title_jpn/torrents; gid change.
function createGalleryEnqueueTriggers(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS gallery_ai_tci_queue
    AFTER INSERT ON gallery
    BEGIN
      INSERT OR IGNORE INTO tci_new_gid(gid) VALUES (NEW.gid);
    END;
  `)

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS gallery_au_tci_queue_content
    AFTER UPDATE OF title, title_jpn, torrents ON gallery
    BEGIN
      INSERT OR IGNORE INTO tci_new_gid(gid) VALUES (NEW.gid);
    END;
  `)

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS gallery_au_tci_queue_gid
    AFTER UPDATE OF gid ON gallery
    BEGIN
      INSERT OR IGNORE INTO tci_new_gid(gid) VALUES (NEW.gid);
      INSERT OR IGNORE INTO tci_new_gid(gid) VALUES (OLD.gid);
    END;
  `)
  // -- Optional but recommended: when a gallery row is deleted, purge its variants immediately.
  // -- (If you prefer to handle via the queue worker, just enqueue OLD.gid instead.)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS gallery_ad_tci_purge
    AFTER DELETE ON gallery
    BEGIN
      DELETE FROM title_core_index WHERE gid = OLD.gid;         -- cascades via tci_* cleanup triggers
      -- If you prefer queue-based cleanup, replace the DELETE with:
      -- INSERT OR IGNORE INTO tci_new_gid(gid) VALUES (OLD.gid);
    END;
  `)
}

/* ------------------------ exports ------------------------ */

module.exports = {
  initTitleCoreIndex,
  isDBInited
  // matchByTitleCore(...) {},
  // searchTciFts(...) {},
}
