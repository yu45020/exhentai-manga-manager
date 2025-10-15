const { normalizeTitle, NORM_VERSION } = require('./normalizer')
const JSON5 = require('json5')
// TODO: rewrite using node-sqlite3
//  the title table should only have the title_core_norm and title_full_norm
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
      createOrRebuildFts(db, /*fresh=*/true)
      setNormVersion(db, NORM_VERSION)
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

// verify expected columns are present
  function hasColumns(db, table, expected) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    return expected.every(c => cols.includes(c))
  }

  // check norm version
  if (!tableExists(db, 'title_core_norm_version')) return false
  if (getNormVersion(db) !== NORM_VERSION) return false
  // check title table
  if (!tableExists(db, 'title_core_index')) return false
  // check fts table
  if (!tableExists(db, 'tci_fts')) return false
  // check index
  if (!hasColumns(db, 'title_core_index', ['gid'])) return false
  return indexExists(db, 'uniq_tci_gid_title')

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
  db.exec(`
    DROP TRIGGER IF EXISTS tci_ai;
    DROP TRIGGER IF EXISTS tci_au;
    DROP TRIGGER IF EXISTS tci_ad;
    DROP TABLE   IF EXISTS tci_fts;
    DROP TABLE   IF EXISTS title_core_index;
  `)
}

function createIndexTable(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS title_core_index
      (
          gid                 INTEGER NOT NULL,
          title_full_norm     TEXT    NOT NULL,
          title_core_norm     TEXT    NOT NULL,
          title_core_norm_seg TEXT    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_tci_gid_title ON title_core_index (gid, title_full_norm);
      CREATE INDEX IF NOT EXISTS idx_tci_gid ON title_core_index (gid);
  `)
  // the gid column in gallery is the primary key
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
  const selectPage = db.prepare(`
      SELECT q.rowid, q.gid, g.title, g.title_jpn, g.torrents
      FROM tci_new_gid AS q
               JOIN gallery AS g ON g.gid = q.gid
      WHERE (@last IS NULL OR q.gid > @last)
      ORDER BY q.gid
      LIMIT @limit
  `)
  const delQueueRange = db.prepare(`DELETE
                                    FROM tci_new_gid
                                    WHERE rowid >= ?
                                      AND rowid <= ?`)
  insertFromGallery(db, selectPage, totalRows, { delQueueRange: delQueueRange })
  // in case some gids in the tci_new_gid are missing in the gallery table, we empty the table
  db.exec(`DELETE
           FROM tci_new_gid
           WHERE NOT EXISTS (SELECT 1 FROM gallery WHERE gallery.gid = tci_new_gid.gid);`)
}

function insertFromGallery(db, query, totalRows, opts = {}) {
  const { delQueueRange = null, pageSize = 10000 } = opts
  const insert = db.prepare(`
      INSERT OR IGNORE INTO title_core_index
          (gid, title_full_norm, title_core_norm, title_core_norm_seg)
      VALUES (?, ?, ?, ?)
  `)

  const insertPageTxn = db.transaction((rows) => {
    for (const row of rows) {
      const candidates = getTitleCandidates(row) // title_jpn, title, torrent names
      for (const raw of candidates) {
        const n = normalizeTitle(raw)
        insert.run(
            row.gid,
            n.title_full_norm,
            n.title_core_norm,
            n.title_core_norm_seg
        )
      }
    }
  })

  let last = 0 //gid is positive
  let processed = 0
  while (true) {
    // 1) Materialize a single page (cursor closes immediately after .all())
    const rows = query.all({ last, limit: pageSize })
    if (rows.length === 0) break

    // 2) Insert the page in one atomic transaction
    insertPageTxn(rows)

    // 3) Advance the keyset
    last = rows[rows.length - 1].gid
    processed += rows.length
    // Clear processed queue range (fast)
    if (delQueueRange) {
      const firstRowid = rows[0].rowid
      const lastRowid = rows[rows.length - 1].rowid
      delQueueRange.run(firstRowid, lastRowid)
    }
    if (processed % 100000 === 0) console.log(`Processed ${(processed / totalRows * 100).toFixed(2)}% …`)
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
  // content-backed FTS so we can REBUILD from title_core_index
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tci_fts USING fts5(
      title_core_norm_seg,
      content='title_core_index',
      content_rowid='gid',
      prefix='1 2' 
    );
  `)

  // (Re)create triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tci_ai AFTER INSERT ON title_core_index BEGIN
      INSERT INTO tci_fts(gid, title_full_norm, title_core_norm, title_core_norm_seg)
      VALUES (new.gid, new.title_full_norm, new.title_core_norm, new.title_core_norm_seg);
    END;

    CREATE TRIGGER IF NOT EXISTS tci_au AFTER UPDATE ON title_core_index BEGIN
      INSERT INTO tci_fts(tci_fts, gid, title_full_norm, title_core_norm, title_core_norm_seg)
      VALUES ('delete', old.gid, old.title_full_norm, old.title_core_norm, old.title_core_norm_seg);
      INSERT INTO tci_fts(gid, title_full_norm, title_core_norm, title_core_norm_seg)
      VALUES (new.gid, new.title_full_norm, new.title_core_norm, new.title_core_norm_seg);
    END;

    CREATE TRIGGER IF NOT EXISTS tci_ad AFTER DELETE ON title_core_index BEGIN
      INSERT INTO tci_fts(tci_fts, gid, title_full_norm, title_core_norm, title_core_norm_seg)
      VALUES ('delete', old.gid, old.title_full_norm, old.title_core_norm, old.title_core_norm_seg);
    END;
  `)

  if (fresh) {
    // Rebuild from the content table to avoid row-by-row inserts
    db.exec(`INSERT INTO tci_fts(tci_fts)
             VALUES ('rebuild');`)
  }
}

function ensureFtsAndTriggers(db) {
  // If FTS table is missing (or someone dropped triggers), recreate them
  if (!tableExists(db, 'tci_fts')) {
    createOrRebuildFts(db, /*fresh=*/true)
    console.log('Created FTS table and triggers.')
    return
  }
  // Validate triggers exist (cheap heuristic: try a rebuild if FTS is empty but content is not)
  const tciCount = db.prepare(`SELECT COUNT(*) AS c
                               FROM title_core_index`).get().c | 0
  const ftsCount = db.prepare(`SELECT COUNT(*) AS c
                               FROM tci_fts`).get().c | 0
  if (tciCount > 0 && ftsCount === 0) {
    // FTS is empty → rebuild from content
    db.exec(`INSERT INTO tci_fts(tci_fts)
             VALUES ('rebuild');`)
  }
}

/* ------------------------ Queue + triggers ------------------------ */
function ensureGalleryIndex(db) {
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gallery_gid ON gallery (gid);
      CREATE INDEX IF NOT EXISTS idx_gallery_token ON gallery (token);
  `)
}

// Deduped queue of gids that need (re)indexing in title_core_index.
function ensureQueueTable(db) {
  // this table stores gids that are updated/inserted in the gallery table
  db.exec(`
      CREATE TABLE IF NOT EXISTS tci_new_gid
      (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,
          gid   INTEGER
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
}


/* ------------------------ exports ------------------------ */

module.exports = {
  initTitleCoreIndex,
  isDBInited
  // matchByTitleCore(...) {},
  // searchTciFts(...) {},
}
