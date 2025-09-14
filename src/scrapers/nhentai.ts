/* Parse metadata from a nhentai.net  */
// TODO: all tags are grouped into "misc" in the current implementation
//       we might want to split them into finer categories later

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
] as const

type Category = (typeof CATEGORY_OPTIONS)[number]

type BookMeta = {
  title: string
  category: Category            // <-- now constrained to the above
  artists: string[]
  languages: string[]
  pages: number
  parodies: string[]
  characters: string[]
  tags: string[]
}

export type FacetDict = Partial<Record<'artist' | 'language' | 'parody' | 'character' | 'misc', string[]>>

// --- helpers  ---
export function buildFacetDict(meta: BookMeta): FacetDict {
  const entries: [keyof FacetDict, string[]][] = [
    ['artist', meta.artists],
    ['language', meta.languages],
    ['parody', meta.parodies],
    ['character', meta.characters],
    ['misc', meta.tags],
  ]

  const out: FacetDict = {}
  for (const [key, arr] of entries) {
    const cleaned = Array.from(new Set(arr.map(s => s.trim()).filter(Boolean)))
    if (cleaned.length) out[key] = cleaned
  }
  return out
}

function findContainer(doc: Document, label: string): Element | null {
  const wanted = label.toLowerCase()
  const boxes = doc.querySelectorAll('#info-block #tags .tag-container.field-name')
  for (const el of boxes) {
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

function extractList(doc: Document, label: string): string[] {
  const box = findContainer(doc, label)
  if (!box) return []
  const out = new Set<string>()
  box.querySelectorAll('span.tags a .name').forEach((n) => {
    const v = (n.textContent || '').trim()
    if (v) out.add(v)
  })
  return Array.from(out)
}

// 2) Category enforcement
const toKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const CATEGORY_MAP: Record<string, Category> = CATEGORY_OPTIONS.reduce((acc, c) => {
  acc[toKey(c)] = c
  return acc
}, {} as Record<string, Category>)

/** Pick the first recognized category; fallback to "Misc" */
function pickCategory(candidates: string[]): Category {
  for (const raw of candidates) {
    const key = toKey(raw)
    if (CATEGORY_MAP[key]) return CATEGORY_MAP[key]
  }
  return 'Misc'
}

function parseNhentaiInfo(html: string): BookMeta {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  const title =
    (doc.querySelector('#info-block h1.title .pretty')?.textContent || '').trim() ||
    (doc.querySelector('#info-block h1.title')?.textContent || '').trim() ||
    ''

  const categoriesList = extractList(doc, 'Categories')
  const category = pickCategory(categoriesList)   // <-- enforced here

  const artists    = extractList(doc, 'Artists')
  const languages  = extractList(doc, 'Languages')
  const parodies   = extractList(doc, 'Parodies')
  const characters = extractList(doc, 'Characters')
  const tags       = extractList(doc, 'Tags')

  let pages = 0
  const pagesBox = findContainer(doc, 'Pages')
  if (pagesBox) {
    const raw = (pagesBox.querySelector('.tags .name')?.textContent || '').trim()
    const n = parseInt(raw, 10)
    pages = Number.isFinite(n) ? n : 0
  }

  return { title, category, artists, languages, pages, parodies, characters, tags }
}

// Optional fetcher
export async function fetchNhentaiMeta(url: string): Promise<BookMeta> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`)
  const html = await res.text()
  return parseNhentaiInfo(html)
}
