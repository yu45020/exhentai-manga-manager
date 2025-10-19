// Search order when category is unknown / when primary bucket misses

export const CATEGORY_ORDER = [
  'artist',
  'parody',
  'group',
  'character',
  'female',
  'mixed',
  'male',
  'other',
  'language',
  'cosplayer',
  'location',
  'reclass',
  'rows'
]


// --------------    build translators   --------------
// payload is from loadTranslationDict {ts, data:{translation dict}}

export function makeTranslators(buckets, categoryOrder = CATEGORY_ORDER) {
  // payload.data = buckets = {category:{...}, parody:{}...}
  const translator = makeLayeredResolver(buckets, categoryOrder)

  const translatorsByCat = Object.create(null)
  for (const cat of Object.keys(buckets)) {
    translatorsByCat[cat] = makeSingleTranslator(buckets[cat])
  }

  // convenience: get a cat-only translator on demand
  function getSingleTranslator(cat) {
    const b = buckets[cat]
    return b ? makeSingleTranslator(b) : ((key) => echoRecord(key))
  }

  return {
    // Layered: translate(word, category?)
    translator,
    // Cat-only factory: translateSingle(category)(word)
    getSingleTranslator,
    // Pre-made per-category functions
    translatorsByCat,
    // Optional: expose raw buckets for diagnostics
    // buckets,
  }
}

// helpers
export const norm = (k) => String(k ?? '').trim().toLowerCase()

export const echoRecord = (key) => ({ name: String(key ?? ''), intro: undefined })
const isMap = (x) => x instanceof Map


function bucketGet(bucket, nk) {
  if (!bucket) return undefined
  return isMap(bucket) ? bucket.get(nk) : bucket[nk] // return {name, intro, ...}
}

// Single-key translator for a known category (no cross-category fallback)
export function makeSingleTranslator(catBucket) {
  return (key) => {
    const nk = norm(key)
    const hit = bucketGet(catBucket, nk)
    return hit ?? echoRecord(key)
  }
}


// Layered resolver: try provided category, then fall back across others
export function makeLayeredResolver(buckets) {
  const memo = new Map() // category -> Map(nk -> {name,intro})
  const ensureInner = (cat) => {
    const c = cat || ''
    let inner = memo.get(c)
    if (!inner) memo.set(c, (inner = new Map()))
    return inner
  }
  const order = CATEGORY_ORDER.filter((c) => !!buckets[c])

  return (key, category) => {
    const nk = norm(key)
    const inner = ensureInner(category)
    if (inner.has(nk)) return inner.get(nk)

    if (category && buckets[category]) {
      const hit = bucketGet(buckets[category], nk)
      if (hit) {
        inner.set(nk, hit)
        return hit
      }
    }
    for (const cat of order) {
      if (category && cat === category) continue
      const hit = bucketGet(buckets[cat], nk)
      if (hit) {
        inner.set(nk, hit)
        return hit
      }
    }
    const fb = echoRecord(key)
    inner.set(nk, fb)
    return fb
  }
}

