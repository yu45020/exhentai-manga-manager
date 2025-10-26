// Worker Thread Pool

const { searchOne, ensureDb } = require('./pipeline')

/**
 * Piscina calls this function in worker threads.
 * @param {{ row: {id:any, title:string, idx?:number}, params: { dbPath:string, CFG?:object } }} payload
 */
module.exports = async function runTask(payload) {
  const { row, params } = payload
  const dbPath = params && params.dbPath
  const db = ensureDb(dbPath)
  const cfg = (params && params.CFG) || {}
  const res = searchOne(db, row.title, cfg)
  return {
    row: row,
    matched: res.matched,
    decision: res.decision,
    reason: res.reason,
    diagnostics: res.diagnostics,
  }
}
