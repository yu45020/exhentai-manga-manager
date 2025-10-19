const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const v8 = require('v8')
const { ipcMain } = require('electron')
const { norm } = require('./translationResolver')
// Search order when category is unknown / when primary bucket misses


// --- build translation dict ----
const TRAN_URL = 'https://github.com/EhTagTranslation/Database/releases/latest/download/db.text.json'
const ONE_MONTH_MS = 90 * 24 * 60 * 60 * 1000 // ~90 days

// loading & building the translation dict from source json
async function loadTranslationDict(storePath,
                                   jsonFilename = 'db.text.json',
                                   binFilename = 'translation.bin') {
  const binPath = path.join(storePath, binFilename)
  const jsonPath = path.join(storePath, jsonFilename)
  // console.log('loadTranslationDict', storePath, binPath, jsonPath)
  const now = Date.now()
  // Ensure directory exists
  fs.mkdirSync(storePath, { recursive: true })
  // 1) try from bin
  try {
    const statBin = await fsp.stat(binPath)
    const binTs = payload?.ts || statBin.mtimeMs || 0
    if ((now - binTs) < ONE_MONTH_MS) {
      const buf = await fsp.readFile(binPath)
      const payload = v8.deserialize(buf)
      if (payload?.data) {
        return payload
      }
    }
  } catch {}
  // 2) try from json
  try {
    const statJson = await fsp.stat(jsonPath)
    const jsonTs = statJson?.mtimeMs
    if ((now - jsonTs) < ONE_MONTH_MS) {
      const raw = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
      return await buildFromJson(raw, binPath)
    }
  } catch {}
  // 3) fetch from github
  // TODO: remove the throw
  throw new Error('Failed to load translation file')
  console.log('Downloading translation file from github ...')
  try {
    const res = await fetchWithTimeout(TRAN_URL, { timeout: 5000 }) // wait 5s
    const raw = await res.json()
    await fsp.writeFile(jsonPath, JSON.stringify(raw, null, 2), 'utf8')
    return buildFromJson(raw, binPath)
  } catch (e) {
    console.log('Failed to fetch translation file', e)
  }
}

// --------------    helpers     --------------
async function buildFromJson(raw, binFile) {
  const buckets = buildBucketsFromJson(raw)
  if (!buckets) throw new Error('Invalid translation JSON structure')

  const payload = { ts: Date.now(), data: buckets }
  try {
    const buf = v8.serialize(payload)
    await fsp.writeFile(binFile, buf)
  } catch (e) {
    console.log('Failed to serialize translation data', e)
  }
  return payload
}

/**
 * Build lightweight per-namespace lookup buckets from the real JSON:
 *   json = { data: [ { namespace, data: { englishKey: {name: translated}, ... } }, ... ] }
 * We do NOT flatten across namespaces; we index each namespace separately.
 */
function buildBucketsFromJson(json) {
  const buckets = Object.create(null) // { [namespace]: { nk -> {name,intro} } }
  for (const item of json?.data || []) {
    const ns = item?.namespace
    const d = item?.data
    if (!ns || !d) continue
    const bucket = Object.create(null)
    for (const [english, rec] of Object.entries(d)) {
      const nk = norm(english)
      const out = extractRecord(rec)
      if (out) bucket[nk] = out
    }
    buckets[ns] = bucket
  }
  return buckets
}


function extractRecord(v) {
  if (v == null) return undefined
  if (typeof v === 'string') return { name: v }                 // tolerate string-only
  if (typeof v === 'object') {
    const name = v.name ?? undefined
    const intro = v.intro ?? v.description ?? undefined         // keep extra if present
    if (name != null || intro != null) return { name, intro }
  }
  return undefined
}

async function fetchWithTimeout(url, { timeout = 8000 } = {}) {
  // default 8s timeout
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'AbortError')), timeout)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}


// --------------    utility   --------------

let translationPayload = null

async function initTranslations(storePath) {
  const storeFolder = path.resolve(storePath)
  if (!storeFolder) throw new Error('storePath is required')
  translationPayload = await loadTranslationDict(storeFolder)
  return translationPayload
}

// setup IPC for the main
function setupTranslationIPC() {
  ipcMain.handle('translation:get', () => {
    if (!translationPayload) return { ok: false, error: 'not-initialized' }
    return { ok: true, ...translationPayload }
  })
}

module.exports = { initTranslations, setupTranslationIPC }
