// Worker Thread Pool

const { searchOne, ensureDb } = require('./pipeline')

/**
 * Piscina calls this function in worker threads.
 * @param {{ row: {id:any, title:string, idx?:number}, params: { dbPath:string } }} payload
 */
module.exports = async function runTask(payload) {
  const { row, params } = payload
  const dbPath = params && params.dbPath
  const db = ensureDb(dbPath)
  const res = searchOne(db, row.title)
  return {
    row: row,
    matched: res.matched,
    decision: res.decision,
    reason: res.reason,
    diagnostics: res.diagnostics,
  }
}
