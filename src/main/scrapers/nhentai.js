import TAG_DICT from './tag-dict.json'

// 1) Canonical options from pinia.js
const CATEGORY_OPTIONS = [
  'Doujinshi',
  'Manga',
  'Artist CG',
  'Game CG',
  'Non-H',
  'Image Set',
  'Western',
  'Cosplay',
  'Asian Porn',
  'Misc',
]

function normKey(s) {
  // fold accents, lowercase, collapse non-alnum
  const base = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function classifyMiscTags(misc) {
  const out = { female: [], male: [], mixed: [], cosplayer: [], other: [], rest: [] }
  const seen = {
    female: new Set(), male: new Set(), mixed: new Set(), other: new Set(),
  }

  for (const raw of misc ?? []) {
    const t = raw?.trim()
    if (!t) continue

    // Try direct, then normalized key
    const direct = (TAG_DICT)[t]
    let cat = direct ?? (TAG_DICT)[normKey(t)] ?? 'other'
    if (!(cat in seen)) cat = 'other'

    if (!seen[cat].has(t)) {
      seen[cat].add(t)
      out[cat].push(t)
    }
  }
  return out
}

// --- helpers  ---
function buildFacetDict(meta) {
  const out = {}

  const add = (k, arr) => {
    const cleaned = Array.from(new Set((arr ?? []).map(s => s.trim()).filter(Boolean)))
    if (cleaned.length) out[k] = cleaned
  }

  add('artist', meta.artists)
  add('group', meta.groups)
  add('language', meta.languages)
  add('parody', meta.parodies)
  add('character', meta.characters)

  const cats = classifyMiscTags(meta.misc ?? [])
  for (const k of ['female', 'male', 'mixed', 'cosplayer', 'rest', 'other']) {
    if (cats[k].length) out[k] = cats[k]
  }

  return out
}

function findContainer(boxes, label) {
  const wanted = label.toLowerCase()
  for (const el of Array.from(boxes)) {
    let labelText = ''
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) labelText += n.textContent || ''
      else break
    }
    const norm = labelText.trim().replace(/:$/, '').toLowerCase()
    if (norm === wanted) return el
  }
  return null
}

function extractList(boxes, label) {
  const box = findContainer(boxes, label)
  if (!box) return []
  const out = new Set()
  box.querySelectorAll('span.tags a .name').forEach((n) => {
    const v = (n.textContent || '').trim()
    if (v) out.add(v)
  })
  return Array.from(out)
}

// 2) Category enforcement
const toKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const CATEGORY_MAP = CATEGORY_OPTIONS.reduce((acc, c) => {
  acc[toKey(c)] = c
  return acc
}, {})

/** Pick the first recognized category; fallback to "Misc" */
function pickCategory(candidates) {
  for (const raw of candidates) {
    const key = toKey(raw)
    if (CATEGORY_MAP[key]) return CATEGORY_MAP[key]
  }
  return 'Misc'
}

function parseNhentaiInfo(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const boxes = doc.querySelectorAll('#info-block #tags .tag-container.field-name')
  const getText = (sel) => (doc.querySelector(sel)?.textContent || '').trim()

  // there are two title lines;
  const title = getText('#info-block h1.title .pretty') || getText('#info-block h1.title') || ''
  const title_jpn = getText('#info-block h2.title .pretty') || getText('#info-block h2.title') || ''

  const categoriesList = extractList(boxes, 'Categories')
  const category = pickCategory(categoriesList)
  const artists = extractList(boxes, 'Artists')
  const groups = extractList(boxes, 'Groups')
  const languages = extractList(boxes, 'Languages')
  const parodies = extractList(boxes, 'Parodies')
  const characters = extractList(boxes, 'Characters')
  const misc = extractList(boxes, 'Tags')

  let pages = 0
  const pagesBox = findContainer(boxes, 'Pages')
  if (pagesBox) {
    const raw = (pagesBox.querySelector('.tags .name')?.textContent || '').trim()
    const n = parseInt(raw, 10)
    pages = Number.isFinite(n) ? n : 0
  }
  let tags = {} // to be filled
  return { title, title_jpn, category, artists, groups, languages, pages, parodies, characters, misc, tags }
}

export async function fetchNhentaiMeta(url, wcId) {
  try {
    const res = await window.ipcRenderer.invoke('searchSessionFetchUrl', { url, wcId })
    const data = parseNhentaiInfo(res)
    data.tags = buildFacetDict(data)
    return data
  } catch (e) {
    console.log(`url: ${url}, wcId: ${wcId}`, e)
    throw new Error(`fetchNhentaiMeta failed: ${e}`)
  }


}

export async function fetchNhentaiPartialMeta(url, wcId) {
  const data = await fetchNhentaiMeta(url, wcId)
  const tags = Object.fromEntries(
      Object.entries({ groups: data.groups, artists: data.artists }).filter(([, v]) =>
          Array.isArray(v) ? v.length > 0 : Boolean(v),
      ),
  )
  return { category: data.category, tags }
}