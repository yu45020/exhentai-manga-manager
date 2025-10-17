// src/composables/useTranslationDict.js
// TODO centralize translation dict loading
import { shallowRef, ref, watch } from 'vue'
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000 // ~30 days
// const TRAN_URL = 'https://github.com/EhTagTranslation/Database/releases/latest/download/db.text.json'

async function loadTranslationDict() {
  const now = Date.now()
  const cache = JSON.parse(localStorage.getItem('translationFolderDictCache') || 'null')
  // 1) Fresh cache → use it
  if (cache?.data && (now - (cache.ts || 0) < ONE_MONTH_MS)) {
    console.log('Using cached translation data')
    return cache.data
  }

  // 2) Try disk (userData/translation/db.text.json). Use mtimeMs as freshness.
  try {
    const resp = await ipcRenderer.invoke('read-json-with-stat', {
      dirname: 'translation',
      filename: 'db.text.json',
    })

    if (resp?.ok && resp.json?.data) {
      const dictFromDisk = buildTagDicts(resp.json.data)
      const ts = resp.mtimeMs || now
      // save to cache regardless; if fresh we can return early
      localStorage.setItem('translationFolderDictCache', JSON.stringify({ ts, data: dictFromDisk }))
      const isFresh = (now - ts) < ONE_MONTH_MS
      console.log(`Using translation data from disk`)
      if (isFresh) return dictFromDisk
      // else fall through to download newer
    }
  } catch (e) {
    console.log('Failed to load translation file from disk', e)
    // ignore and fall through
  }
  console.log('Downloading translation file...')
  // TODO: remove the throw
  throw new Error('Failed to load translation file')
  // 3) Download latest → save to disk → cache → return
  const downloaded = await ipcRenderer.invoke('download-tag-translation-file') // parsed JSON
  await ipcRenderer.invoke('save-file', {
    dirname: 'translation',
    filename: 'db.text.json',
    content: JSON.stringify(downloaded, null, 2),
  })
  const dict = buildTagDicts(downloaded?.data)
  localStorage.setItem('translationFolderDictCache', JSON.stringify({ ts: now, data: dict }))
  return dict
}


let dictRef
let readyRef
let loadingRef
let errorRef
let translators

function makeTagTranslator(dict) {
  const cache = new Map()
  return (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return '-'
    const key = arr.join('\u0001')
    if (cache.has(key)) return cache.get(key)
    const out = arr.map(x => (dict && dict[x]) || x).join(', ')
    cache.set(key, out)
    return out
  }
}

export function useTranslationDict() {
  if (!dictRef) {
    dictRef = shallowRef(null)
    readyRef = ref(false)
    loadingRef = ref(false)
    errorRef = ref(null)

    translators = {
      artist: ref((a) => (Array.isArray(a) && a.join(', ')) || '-'),
      group: ref((a) => (Array.isArray(a) && a.join(', ')) || '-'),
      parody: ref((a) => (Array.isArray(a) && a.join(', ')) || '-'),
    }

    watch(dictRef, (d) => {
      translators.artist.value = makeTagTranslator(d?.artist || null)
      translators.group.value = makeTagTranslator(d?.group || null)
      translators.parody.value = makeTagTranslator(d?.parody || null)
      readyRef.value = !!d
    }, { immediate: true })
  }

  async function ensureLoaded() {
    if (loadingRef.value || dictRef.value) return
    loadingRef.value = true
    errorRef.value = null
    try {
      const dict = await loadTranslationDict()
      if (dict) dictRef.value = dict
    } catch (e) {
      errorRef.value = e
    } finally {
      loadingRef.value = false
    }
  }

  return {
    dict: dictRef,
    dictReady: readyRef,
    dictLoading: loadingRef,
    dictError: errorRef,
    translateArtist: translators.artist, // fn: (tags[]) => string
    translateGroup: translators.group,
    translateParody: translators.parody,
    ensureLoaded,                         // idempotent
  }
}
