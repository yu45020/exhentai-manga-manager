// CommonJS
const Database = require('better-sqlite3')
const { matchOne, applyFtsPragmas } = require('./pipeline')

let db

/**
 * Piscina calls this function in worker threads.
 * @param {{ row: {id:any, title:string, idx?:number}, params: { dbPath:string } }} payload
 */
module.exports = async function runTask(payload) {
  const { row, params } = payload
  if (!db) {
    if (!params?.dbPath) throw new Error('worker: params.dbPath is required')
    db = new Database(params.dbPath, { readonly: true, fileMustExist: true })
    applyFtsPragmas(db)
    process.on('exit', () => { try { db.close() } catch {} })
  }

  const res = matchOne(db, row.title)
  return {
    row: row,
    matched: res.matched,
    decision: res.decision,
    reason: res.reason,
    diagnostics: res.diagnostics,
  }
}
