// check whether a db has the same schema as the api_dump.sqlite

// Pass an open better-sqlite3 Database instance `db`
export function checkGallerySchema(db, { requireExactOrder = false, allowExtraColumns = true } = {}) {
  // 1) Does the table exist?
  const tableRow = db
      .prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?')
      .get('gallery')

  if (!tableRow) {
    return { exists: false, exactMatch: false, missingColumns: [], extraColumns: [], detail: 'Table not found' }
  }

  // 2) Introspect actual columns
  const actual = db.prepare('PRAGMA table_info(\'gallery\')').all()
  // actual row shape: { cid, name, type, notnull, dflt_value, pk }

  // 3) Your expected schema (from the DDL)
  const EXPECTED = [
    { name: 'gid', type: 'INTEGER', notnull: 1, pk: 1 },
    { name: 'token', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'title_jpn', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'posted', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'uploader', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'category', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'rating', type: 'FLOAT', notnull: 0, pk: 0 }, // FLOAT in the DDL
    { name: 'thumb', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'filesize', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'filecount', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'torrentcount', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'torrents', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'artist', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'group', type: 'TEXT', notnull: 0, pk: 0 }, // originally "group" quoted
    { name: 'parody', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'character', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'female', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'male', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'language', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'mixed', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'other', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'cosplayer', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'rest', type: 'TEXT', notnull: 0, pk: 0 },
    // { name: 'parent_gid', type: 'INTEGER', notnull: 0, pk: 0 },
    // { name: 'parent_key', type: 'TEXT', notnull: 0, pk: 0 },
    // { name: 'first_gid', type: 'INTEGER', notnull: 0, pk: 0 },
    // { name: 'first_key', type: 'TEXT', notnull: 0, pk: 0 },
    // { name: 'current_gid', type: 'INTEGER', notnull: 0, pk: 0 },
    // { name: 'current_key', type: 'TEXT', notnull: 0, pk: 0 },
    // { name: 'expunged', type: 'INTEGER', notnull: 0, pk: 0 },
    // { name: 'disowned', type: 'INTEGER', notnull: 0, pk: 0 },
    // { name: 'removed', type: 'INTEGER', notnull: 0, pk: 0 },
    // { name: 'dumped', type: 'INTEGER', notnull: 0, pk: 0 },
  ]

  // 4) Helpers
  // Normalize a declared type to SQLite affinity: INTEGER | REAL | TEXT | BLOB | NUMERIC
  const typeAlias = (decl) => {
    const t = (decl || '').trim().toUpperCase()

    // 1) INTEGER affinity
    if (t.includes('INT')) return 'INTEGER' // INT, INTEGER, TINYINT, BIGINT...

    // 2) TEXT affinity
    if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT' // VARCHAR, NVARCHAR, CHAR(20), CLOB, TEXT

    // 3) BLOB affinity (empty type or explicit BLOB)
    if (t.includes('BLOB') || t === '') return 'BLOB'

    // 4) REAL affinity
    if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL' // REAL, FLOAT, DOUBLE, DOUBLE PRECISION

    // 5) NUMERIC affinity (catch-all: DECIMAL, NUMERIC, BOOLEAN, DATE/TIME, etc.)
    return 'NUMERIC'
  }


  const expectedMap = new Map(EXPECTED.map((c, i) => [c.name, { ...c, idx: i }]))
  const actualMap = new Map(actual.map((c, i) => [c.name, { ...c, idx: i }]))

  // 5) Diffs
  const missingColumns = []
  const extraColumns = []
  const typeMismatches = []
  const notnullMismatches = []
  const pkMismatches = []

  for (const exp of EXPECTED) {
    const got = actualMap.get(exp.name)
    if (!got) {
      missingColumns.push(exp.name)
      continue
    }
    // type compare (with aliasing)
    if (typeAlias(exp.type) !== typeAlias(got.type)) {
      typeMismatches.push({ name: exp.name, expected: exp.type, actual: got.type })
    }
    // notnull compare
    const expNN = exp.notnull ? 1 : 0
    const gotNN = got.notnull ? 1 : 0
    if (expNN !== gotNN) {
      notnullMismatches.push({ name: exp.name, expected: expNN, actual: gotNN })
    }
    // pk compare
    const expPK = exp.pk ? 1 : 0
    const gotPK = got.pk ? 1 : 0
    if (expPK !== gotPK) {
      pkMismatches.push({ name: exp.name, expected: expPK, actual: gotPK })
    }
  }

  for (const a of actual) {
    if (!expectedMap.has(a.name)) {
      extraColumns.push(a.name)
    }
  }

  // 6) Optional: order strictness
  let orderMismatch = false
  if (requireExactOrder) {
    // compare names sequence
    const expOrder = EXPECTED.map(c => c.name).join('|')
    const actOrder = actual.map(c => c.name).join('|')
    orderMismatch = expOrder !== actOrder
  }

  const exactMatch =
      missingColumns.length === 0 &&
      (extraColumns.length === 0 || allowExtraColumns) &&
      typeMismatches.length === 0 &&
      notnullMismatches.length === 0 &&
      pkMismatches.length === 0 &&
      (!requireExactOrder || !orderMismatch)

  const result = {
    exists: true,
    exactMatch,
    requireExactOrder,
    allowExtraColumns,
    orderMismatch,
    missingColumns,
    extraColumns,
    typeMismatches,
    notnullMismatches,
    pkMismatches,
    // optional: expose the CREATE TABLE SQL that SQLite recorded
    // createSql: tableRow.sql,
    actualColumns: actual, // pragma table_info rows
  }
  if (!exactMatch) {
    console.warn('The db is not exactly the same as the `api_dump.sqlite`')
  }
  return result
}
