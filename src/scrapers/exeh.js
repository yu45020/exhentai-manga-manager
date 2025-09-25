// scraper for ex/ehentai.org

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

const toKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const CATEGORY_MAP = CATEGORY_OPTIONS.reduce((acc, c) => {
  acc[toKey(c)] = c
  return acc
}, {})

function pickCategory(raw) {
  const key = toKey(raw)
  if (CATEGORY_MAP[key]) {
    return CATEGORY_MAP[key]
  } else {
    return 'Misc'
  }

}

function parseWithDoc(doc) {
  const text = (el) => (el?.textContent ?? '').trim()
  const q = (sel, root = doc) => root.querySelector(sel)
  const qAll = (sel, root = doc) => Array.from(root.querySelectorAll(sel))

  const category = pickCategory(text(q('#gdc .cs')) || '')

  const group = [], artist = [], cosplayer = []
  qAll('#taglist tr').forEach(tr => {
    const header = text(q('td.tc', tr)).replace(/:$/, '').toLowerCase()
    if (header === 'group' || header === 'artist' || header === 'cosplayer') {
      const values = qAll('td:nth-of-type(2) a', tr).map(a => text(a)).filter(Boolean)
      if (header === 'group') {
        group.push(...values)
      } else if (header === 'artist') {
        artist.push(...values)
      } else if (header === 'cosplayer') {
        cosplayer.push(...values)
      }
    }

  })
  return {category, group, artist, cosplayer }
}

function parseEhExInfo(html) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const {category, group, artist, cosplayer} = parseWithDoc(doc)
  const tags = Object.fromEntries(
    Object.entries({ group, artist, cosplayer }).filter(([, v]) =>
      Array.isArray(v) ? v.length > 0 : Boolean(v)
    )
  )
  return { category, tags }
}


// only get category, artist, and group. This function is used to partial update tags when there is no match

export async function fetchEhExPartialMeta(url, wcId) {
  const html = await window.ipcRenderer.invoke('searchSessionFetchUrl', { url, wcId })
  return parseEhExInfo(html)
}
