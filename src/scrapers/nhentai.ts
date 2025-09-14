/* Parse metadata from a nhentai.net  */

import TAG_DICT from '../../data/tag-dict.json'
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

function normKey(s: string): string {
    // fold accents, lowercase, collapse non-alnum
    const base = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    return base.toLowerCase().replace(/[^a-z0-9]+/g, '')
}


function classifyMiscTags(misc: string[]) {
    const out = { female: [], male: [], mixed: [], cosplayer: [], other: [], rest: [] }
    const seen = {
        female: new Set(), male: new Set(), mixed: new Set(), other: new Set()
    }

    for (const raw of misc ?? []) {
        const t = raw?.trim()
        if (!t) continue

        // Try direct, then normalized key
        const direct = (TAG_DICT)[t]
        let cat = direct ?? (TAG_DICT)[normKey(t)] ?? 'rest'
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

    const add = (k, arr: string[] | undefined) => {
        const cleaned = Array.from(new Set((arr ?? []).map(s => s.trim()).filter(Boolean)))
        if (cleaned.length) out[k] = cleaned
    }

    add('artist', meta.artists)
    add('language', meta.languages)
    add('parody', meta.parodies)
    add('character', meta.characters)

    const cats = classifyMiscTags(meta.misc ?? [])
    for (const k of ['female', 'male', 'mixed', 'cosplayer', 'other', 'rest']) {
        if (cats[k].length) out[k] = cats[k]
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


function parseNhentaiInfo(html: string) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const getText = (sel: string) => (doc.querySelector(sel)?.textContent || '').trim()


    // there are two title lines;
    const title = getText('#info-block h1.title .pretty') || getText('#info-block h1.title') || ''
    const title_jpn = getText('#info-block h2.title .pretty') || getText('#info-block h2.title') || ''

    const categoriesList = extractList(doc, 'Categories')
    const category = pickCategory(categoriesList)   // <-- enforced here

    const artists = extractList(doc, 'Artists')
    const languages = extractList(doc, 'Languages')
    const parodies = extractList(doc, 'Parodies')
    const characters = extractList(doc, 'Characters')
    const misc = extractList(doc, 'Tags')

    let pages = 0
    const pagesBox = findContainer(doc, 'Pages')
    if (pagesBox) {
        const raw = (pagesBox.querySelector('.tags .name')?.textContent || '').trim()
        const n = parseInt(raw, 10)
        pages = Number.isFinite(n) ? n : 0
    }
    let tags = {} // to be filled
    return { title, title_jpn, category, artists, languages, pages, parodies, characters, misc, tags }
}

// Optional fetcher
export async function fetchNhentaiMeta(url: string) {
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`)
    const html = await res.text()
    const data = parseNhentaiInfo(html)
    data.tags = buildFacetDict(data)
    return data
}
