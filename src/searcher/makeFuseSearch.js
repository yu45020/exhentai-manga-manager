import Fuse from 'fuse.js'
import { filter as liqeFilter, parse as liqeParse } from 'liqe'


//    keep reserved fields; everything else maps to tags.<field>:
const RESERVED = new Set(['title', 'mtime', 'atime', 'ptime',
  'pagediff', 'status', 'category', 'tags_flat', 'title_jpn', 'filename'
])
// operators, inherit from `cat2letter` `in pinia.js`

const OP_ALIASES = {
  title: ['title', 't'],
  tag: ['tag', 'tags'],
  artist: ['artist', 'a'],
  group: ['group', 'g'],
  parody: ['parody', 'p'],
  category: ['category', 'cat'],
  status: ['status'],
  language: ['language', 'l'],
  character: ['character', 'c'],
  female: ['female', 'f'],
  male: ['male', 'm'],
  mixed: ['mixed', 'x'],
  other: ['other', 'o'],
  cosplay: ['cosplay', 'cos'],
}

// fuse options
const DEFAULT_OPTS = {
  includeScore: true,
  includeMatches: true,
  shouldSort: true,
  minSuggestThreshold: 0.5, // lower means more restrictive
  minRunTitleScore: 0.5,
  ignoreFieldNorm: false,
  fieldNormWeight: 0,
  ignoreLocation: true,
  minMatchCharLength: 1,
  threshold: 0.5,
  location: 0,
  distance: 150,
  ignoreDiacritics: true,
  isCaseSensitive: false,
  useExtendedSearch: true,
  findAllMatches: false, // stop when a perfect match is found
  limitSuggest: 10,
  limitEverything: 20, // TODO check
  limitEachBucket: 5,  // suggestions split across Title/Tag/Everything
  weightTitle: 1,
  weightTitleJpn: 1,
  weightTitleFilename: 1,
  weightEverything: { title: 1, title_jpn: 1, tags_flat: 1 },
  maxSuggestLen: 30
}

/**
 * Factory for Fuse-powered search across bookList.
 * API:
 *   const s = makeFuseSearch(bookList, opts?)
 *   s.suggest(q, limit?) -> [{ label, value, kind, id? }]
 *   s.execQuery({ value, id }) -> { mode, query, results[bookList], error? }
 *   s.rebuild(nextBookList) -> void
 */
export default function makeFuseSearch(providers, userOpts = {}) {

  const { getBookList, getStatusOption, getCategoryOption } = providers
  if (typeof getBookList !== 'function') throw new Error('getBookList provider is required')
  if (typeof getStatusOption !== 'function') throw new Error('getStatusOption provider is required')
  if (typeof getCategoryOption !== 'function') throw new Error('getCategoryOption provider is required')

  // const { statusOption, categoryOption, } = useAppStore()
  // ---- internal state ----
  let bookList = []
  let bookStatus = []
  let bookCategory = []
  // let bookList = Array.isArray(initialBookList) ? initialBookList : []
  // let bookStatus = Array.isArray(statusOption) ? statusOption : []
  // let bookCategory = Array.isArray(categoryOption) ? categoryOption : []

  let bookExtraAttrs, extraAttrKeys
  // ---- options ----

  const OPTS = {
    ...DEFAULT_OPTS,
    ...userOpts,
  }
  // fuse index
  let fuseExtraAttrs = {} // for category, status
  let fuseTitles = null
  let fuseTags = null
  let fuseTagSub = {}

  // internal copy of the this.bookList
  let docs = []
  // list of all subcategories in the tags

  // used to return a book directly from suggestion
  let byId

  // ---- helpers ----
  function buildIndexes() {
    bookList = getBookList()
    bookStatus = getStatusOption()
    bookCategory = getCategoryOption()

    byId = new Map(bookList.map(b => [b.id, b]))
    bookExtraAttrs = {
      category: bookCategory,
      status: bookStatus
    }
    extraAttrKeys = Object.keys(bookExtraAttrs)
    // ------- init targets -------
    const titleDocs = []                    // for fuseTitles
    const tagsFlatSet = new Set()           // for fuseTags
    const tagSubSet = Object.create(null)   // cat -> Set of values

    // Prepare extra attr buckets (status/category)
    const extraBuckets = Object.fromEntries(
        Object.entries(bookExtraAttrs).map(([key, values]) => [key,
          Object.fromEntries([...new Set(values.filter(Boolean))].map(v => [v, []]))
        ])
    )


    // ------- single pass over bookList -------
    for (let i = 0; i < bookList.length; i++) {
      const b = bookList[i]
      const _id = b.id

      // titles/filename (avoid joining unless needed)
      const tr = normStr(b.title)
      const tj = normStr(b.title_jpn)
      const fn = getBasename(b.filepath)

      // tags → normalized per-subcat + flat
      const tagsObj = (b.tags && typeof b.tags === 'object') ? b.tags : {}
      const tags = Object.create(null)
      const tags_flat = []

      for (const [cat, vals] of Object.entries(tagsObj)) {
        const arr = Array.isArray(vals) ? vals : [vals]
        // normalize values once
        const normVals = []
        for (let j = 0; j < arr.length; j++) {
          const v = normStr(arr[j])
          if (!v) continue
          normVals.push(v)
          tags_flat.push(v)
          tagsFlatSet.add(v)
          // tag subcategories set
          const ck = String(cat).toLowerCase()
          if (!tagSubSet[ck]) tagSubSet[ck] = new Set()
          tagSubSet[ck].add(v)
        }
        if (normVals.length) tags[String(cat).toLowerCase()] = normVals
      }

      // liqe doc
      const d = {
        _id,
        __book: b, // back-ref
        // put a readable combined title
        title: [b.title, b.title_jpn, fn].filter(Boolean).join(' ').trim(),
        tags,
        tags_flat,
        mtime: toSec(b?.mtime) || 0,
        atime: toSec(b?.date) || 0,
        ptime: toSec(b?.posted) || 0,
        pagediff: Number(b.pageDiff ?? 0) || 0,
        status: b.status ?? '',
        category: b.category ?? '',
      }
      docs.push(d)

      // fuse titles row (only if any present)
      if (tr || tj || fn) {
        titleDocs.push({ _id, title_raw: tr, title_jpn: tj, filename: fn })
      }

      // extra attributes buckets (status/category)
      for (const key of extraAttrKeys) {
        const vRaw = d[key]
        if (!vRaw) continue
        const v = String(vRaw)
        // if (!extraBuckets[key][v]) extraBuckets[key][v] = []
        extraBuckets[key][v].push(_id) // keep a list of _id
      }
    }

    // 0) preconditions
    if (!Array.isArray(docs)) docs = []

    // 1) Titles index
    fuseTitles = mkFuse(titleDocs, [
      { name: 'title_raw', weight: OPTS.weightTitle },
      { name: 'title_jpn', weight: OPTS.weightTitleJpn },
      { name: 'filename', weight: OPTS.weightTitleFilename }
    ], OPTS)

    // 2) Tags (unique)
    const uniqueTags = Array.from(tagsFlatSet)
    const tagDocs = uniqueTags.map(v => ({ value: v }))
    fuseTags = mkFuse(tagDocs, ['value'], OPTS)

    // 3) Tag subcategories
    const tagSubDoc = Object.create(null) // cat -> [{value}]
    fuseTagSub = Object.create(null)      // cat -> Fuse
    for (const cat of Object.keys(tagSubSet)) {
      const arr = Array.from(tagSubSet[cat]).map(v => ({ value: v }))
      tagSubDoc[cat] = arr
      fuseTagSub[cat] = mkFuse(arr, ['value'], OPTS)
    }

    // 4) Extra attributes
    fuseExtraAttrs = Object.create(null)
    for (const key of extraAttrKeys) {
      const docsForKey = Object.entries(extraBuckets[key]).map(
          ([value, _id]) => ({ value, _id }))
      fuseExtraAttrs[key] = mkFuse(docsForKey, ['value'], OPTS)
      // console.log(`key ${key}- docsForKey`, docsForKey,)
    }
  }


  // initial build
  buildIndexes()

  // ---- public: suggestions for <el-autocomplete> ----
  function suggest(q, limit = OPTS.limitSuggest) {
    const s = String(q || '')
    // const s = normStr(raw)
    if (!s) return []

    // Parse active token/scoped hint once (cheap)
    const { prefix, active, endsWithSpace } = getActiveToken(s)
    console.log('prefix', prefix, 'active', active)

    let op, query
    if (active) {
      op = active.op
      query = String(active.value || '').trim()
    } else {
      const scoped = parseScopedQuery(s)
      op = scoped.op
      query = scoped.query
    }
    if (op && REQUIRES_TERM.has(op) && !query) return []

    // ---- scoped fast-paths (single bucket) -----------------------------------
    const out = []
    if (op === 'title' && fuseTitles) {
      pushTitleRows(prefix, fuseTitles.search(query, { limit }), out, OPTS)
    } else if ((op === 'tag' || op === 'tags') && fuseTags) {
      pushValueRows(prefix, fuseTags.search(query, { limit }), 'tags', out, OPTS)
    } else if (fuseTagSub[op] && fuseTagSub[op]) {
      pushValueRows(prefix, fuseTagSub[op].search(query, { limit }), op, out, OPTS)
    } else if (extraAttrKeys.includes(op) && fuseExtraAttrs[op]) {
      pushValueRows(prefix, fuseExtraAttrs[op].search(query, { limit }), op, out, OPTS)
    } else {
      // ---- unscoped: spread budget across buckets dynamically ----------------
      // active buckets present
      const buckets = []
      if (fuseTitles) buckets.push('title')
      if (fuseTags) buckets.push('tags')
      for (let i = 0; i < extraAttrKeys.length; i++) {
        const k = extraAttrKeys[i]
        if (fuseExtraAttrs && fuseExtraAttrs[k]) buckets.push(k)
      }
      const n = buckets.length || 1
      const each = perBucketLimit(limit, n, OPTS)

      // titles
      if (fuseTitles) pushTitleRows(prefix, fuseTitles.search(query, { limit: each }), out, OPTS)
      // all-tags
      if (fuseTags) pushValueRows(prefix, fuseTags.search(query, { limit: each }), 'tags', out, OPTS)
      // extras (status/category…)
      for (let i = 0; i < extraAttrKeys.length; i++) {
        const k = extraAttrKeys[i]
        const fz = fuseExtraAttrs && fuseExtraAttrs[k]
        if (fz) pushValueRows(prefix, fz.search(query, { limit: each }), k, out, OPTS)
      }
      // (Optional) peek a couple of subcategories only if budget remains:
      // for (let i = 0; i < tagSub.length && out.length < limit; i++) {
      //   const k = tagSub[i]
      //   const fz = fuseTagSub && fuseTagSub[k]
      //   if (fz) pushValueRows(prefix, fz.search(query, { limit: 2 }), k, out, OPTS)
      // }
    }

    // ---- dedupe + final sort/trim --------------------------------------------
    const seen = new Set()
    const deduped = []
    for (let i = 0; i < out.length; i++) {
      const it = out[i]
      const key = it.label + '|' + it.value + '|' + (it.id ?? '')
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(it)
      }
    }
    // a lower score is better
    deduped.sort((a, b) => (a.score || 1) - (b.score || 1))
    if (deduped.length > limit) deduped.length = limit
    return deduped
  }


  // ---- public: run a search; returns an array of original book objects ---
  function execQuery({ query = '', id = null, searchType = 'filter' } = {}) {
    // console.log('run: ', 'mtime:', docs[2].mtime, 'atime:', docs[2].atime, 'ptime:', docs[2].ptime,)
    // console.log('mtime:', bookList[0].mtime)
    // title, status, or category from suggestion list contains a list of book id
    // console.log('execQuery: ', query, id, searchType)
    if (id && searchType === 'direct') {
      console.log('direct: ', query, id)
      const ids = Array.isArray(id) ? id : [id]
      const results = ids.map(i => byId.get(i)).filter(b => b != null)
      return { mode: 'book id', results }
      // return { mode: 'book id', results: [byId.get(id)] }
    }


    let raw = String(query || '').trim()

    if (!raw) return { mode: 'empty', results: [] }
    raw = replaceAliasScop(raw)
    const preprocessed = preprocessQuery(raw)
    console.log(`preprocessed:${preprocessed}`)
    let ast
    try {
      ast = liqeParse(preprocessed)
      console.log('ast: ', ast)
    } catch (e) {
      // Syntax error – return empty but surface the error for the UI to show
      console.log('liqe error: ', e, `preprocessed string: ${preprocessed}`)
      return { mode: 'error', query: raw, error: e?.message || String(e), results: [] }
    }

    // Boolean filter: liqe returns docs that match; you can re-rank later if desired
    const matched = liqeFilter(ast, docs)
    const results = matched.map(d => d.__book)
    return { mode: 'search', query: raw, preprocessed, results }
  }

  // ---- public: rebuild the search indexes from a new bookList ---
  let _t = null // debounced variant if updates burst
  function updateIndex(wait = 200) {
    console.log('Search is updated: ')
    clearTimeout(_t)
    const t0 = performance.now()
    _t = setTimeout(buildIndexes, wait)
    console.log(`Building index run time: ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  }


  return { suggest, execQuery, updateIndex }

}


/** ------------- Index Helpers -------------*/

function mkFuse(list, keys, OPTS, extra = {}) {
  return new Fuse(list, {
    keys,
    ...OPTS,
    // includeScore: OPTS.includeScore,
    // includeMatches: OPTS.includeMatches,
    // shouldSort: OPTS.shouldSort,
    // ignoreLocation: OPTS.ignoreLocation,
    // ignoreFieldNorm: OPTS.ignoreFieldNorm,
    // useExtendedSearch: OPTS.useExtendedSearch,
    ...extra,
  })
}

/** ------------- Suggest Helpers -------------*/
// --- helpers: multi-scope parsing ---
// Compute prefix + active region for suggestions, per the finalized spec.
// - If there is NO completed scope earlier, prefix is '' and the ENTIRE input is active (even with spaces).
// - If there IS a completed scope, prefix = everything up to (and including) the space after the last completed scope,
//   and active = everything after that (can include spaces, unary ops like '-', and/or quotes).
// - A "completed scope" is a token like  <op>:<value>  that is followed by a space (outside quotes).
//   If <value> starts with a quote, that quote must be closed within the same token to count as completed.
function getActiveToken(raw) {
  const s = String(raw ?? '')
  if (!s) return { prefix: '', active: null, endsWithSpace: false }

  // Trailing space ⇒ starting a new token
  if (/\s$/.test(s)) {
    return { prefix: s.replace(/\s*$/, ' '), active: null, endsWithSpace: true }
  }

  // ---------- helpers ----------
  const isSpace = ch => /\s/.test(ch)

  // Control tokens: kept verbatim, excluded from active operator
  const CONTROL_TOKEN_RE = /^(-|\+|~|\*|\(|\)|\||AND|OR|NOT)$/i
  const isControlToken = t => CONTROL_TOKEN_RE.test(t)

  // Whole-word boolean controls (for normalization guard)
  const CONTROL_WORD_RE = /^(AND|OR|NOT)$/i

  // Tokenize by spaces outside quotes; returns [{start,end}] (end exclusive)
  function tokenizeOutsideQuotes(str) {
    const out = []
    const n = str.length
    let i = 0, q = null, esc = false
    while (i < n && isSpace(str[i])) i++
    let start = i
    for (; i < n; i++) {
      const ch = str[i]
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (q) {
        if (ch === q) q = null
        continue
      }
      if (ch === '"' || ch === '\'') {
        q = ch
        continue
      }
      if (isSpace(ch)) {
        if (i > start) out.push({ start, end: i })
        while (i + 1 < n && isSpace(str[i + 1])) i++
        start = i + 1
      }
    }
    if (start < n) out.push({ start, end: n })
    return out
  }

  // Completed scope token: op:value fully within the token; if quoted, quote closed
  function isCompletedScopeToken(txt) {
    const m = /^([^\s"'\\:]+)\s*:\s*(.+)$/.exec(txt)
    if (!m) return false
    const v = m[2]
    const q = v[0]
    if (q === '"' || q === '\'') {
      if (v[v.length - 1] !== q) return false
      let bs = 0
      for (let k = v.length - 2; k >= 0 && v[k] === '\\'; k--) bs++
      if (bs % 2 !== 0) return false
    }
    return true
  }

  // Normalize field operators; NEVER alter control words AND/OR/NOT
  const normalizeOpSafe =
      (typeof normalizeOp === 'function')
          ? (opRaw) => {
            if (!opRaw) return null
            if (CONTROL_WORD_RE.test(opRaw)) return opRaw // keep casing
            return normalizeOp(opRaw)
          }
          : (opRaw) => {
            if (!opRaw) return null
            if (CONTROL_WORD_RE.test(opRaw)) return opRaw
            const k = String(opRaw).toLowerCase()
            return (typeof ALIAS_TO_CANON !== 'undefined' && ALIAS_TO_CANON[k]) || k
          }

  function parseOpValue(chunk) {
    const idx = chunk.indexOf(':')
    if (idx === -1) return { op: null, valueRaw: chunk }
    const left = chunk.slice(0, idx).trim()
    if (!left) return { op: null, valueRaw: chunk }
    const op = normalizeOpSafe(left)
    const valueRaw = chunk.slice(idx + 1).replace(/^\s+/, '')
    return { op, valueRaw }
  }

  function stripMatchedQuotes(v) {
    if (v.length < 2) return v
    const q = v[0]
    if (q !== '"' && q !== '\'') return v
    if (v[v.length - 1] !== q) return v.slice(1) // still typing
    let bs = 0
    for (let k = v.length - 2; k >= 0 && v[k] === '\\'; k--) bs++
    return (bs % 2 === 0) ? v.slice(1, -1) : v.slice(1)
  }

  // ---------- main ----------
  const toks = tokenizeOutsideQuotes(s)
  if (toks.length === 0) return { prefix: '', active: null, endsWithSpace: false }

  // Find last completed scope before the final token
  let lastCompletedScopeIdx = -1
  for (let i = 0; i < toks.length - 1; i++) {
    const txt = s.slice(toks[i].start, toks[i].end)
    if (isCompletedScopeToken(txt)) lastCompletedScopeIdx = i
  }

  // Start of active token index baseline
  let activeFirstIdx = (lastCompletedScopeIdx >= 0) ? (lastCompletedScopeIdx + 1) : 0

  // Skip a RUN of control tokens at the start of the active region:
  // - If a completed scope exists, these controls belong to the prefix after that scope.
  // - If NO completed scope exists, leading controls at the very beginning also belong to the prefix.
  while (activeFirstIdx < toks.length) {
    const tText = s.slice(toks[activeFirstIdx].start, toks[activeFirstIdx].end)
    if (!isControlToken(tText)) break
    activeFirstIdx++
  }

  // If only controls exist (nothing to suggest yet) → treat as new-token position
  if (activeFirstIdx >= toks.length) {
    const prefix = s + ' '
    return { prefix, active: null, endsWithSpace: true }
  }

  // Compute prefix and active slices:
  const activeStart = toks[activeFirstIdx].start
  let prefix
  if (lastCompletedScopeIdx >= 0) {
    // There was a completed scope earlier: prefix includes everything up to activeStart
    prefix = s.slice(0, activeStart)
  } else {
    // No completed scope earlier:
    // - If there were leading control tokens, include them in prefix
    // - Otherwise prefix is empty and whole input is active
    const firstTokenStart = toks[0].start
    if (activeFirstIdx > 0 && firstTokenStart === 0) {
      // We consumed some leading control tokens
      prefix = s.slice(0, activeStart)
    } else {
      prefix = ''
    }
  }

  const activeWhole = (prefix ? s.slice(activeStart) : s)

  // Parse active for op/value (so Fuse can use only the field op, not controls)
  const { op, valueRaw } = parseOpValue(activeWhole)
  const value = stripMatchedQuotes(valueRaw)

  return {
    prefix,                                   // exact slice from s; control words keep original casing
    active: { op, value, raw: activeWhole },  // op normalized (except AND/OR/NOT), raw unchanged
    endsWithSpace: false,
  }
}

function _getActiveToken(raw) {
  const s = String(raw || '')
  if (!s) return { prefix: '', active: null, endsWithSpace: false }

  // 1) If trailing spaces, there is no active token—start a new one after prefix.
  if (/\s$/.test(s)) {
    return { prefix: s.replace(/\s*$/, ' '), active: null, endsWithSpace: true }
  }

  // 2) Find the start index of the last token by scanning backwards, respecting quotes.
  // Tokens are space-separated unless inside quotes (").
  let i = s.length - 1
  // Skip trailing non-space already ensured above, so we can start searching for boundary.
  let inQuotes = false
  let escaped = false

  // Walk backwards until we hit a space that is NOT inside quotes.
  for (; i >= 0; i--) {
    const ch = s[i]
    if (escaped) {                   // previous char was a backslash
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes          // toggle quote state
      continue
    }
    if (!inQuotes && /\s/.test(ch)) {
      // token starts after this space
      i++
      break
    }
  }
  const tokenStart = (i < 0) ? 0 : i
  const token = s.slice(tokenStart)         // raw last token
  const prefixRaw = s.slice(0, tokenStart)  // exact left part, quotes preserved
  const prefix = prefixRaw ? (/\s$/.test(prefixRaw) ? prefixRaw : prefixRaw + ' ') : ''

  // 3) Determine if token is scoped (field : value). Allow spaces after colon.
  // We treat the FIRST ':' in the token as the separator.
  let op = null
  let valueRaw = token
  let colonIdx = token.indexOf(':')
  if (colonIdx !== -1) {
    op = normalizeOp(token.slice(0, colonIdx).trim())
    valueRaw = token.slice(colonIdx + 1).replace(/^\s+/, '') // trim spaces after colon
  }

  // 4) Extract active.value for searching (strip surrounding quotes if present).
  let valueForSearch = valueRaw
  if (valueForSearch.startsWith('"')) {
    // If there is a closing quote, drop both; if not, keep inner without leading quote.
    const hasClosing = valueForSearch.length > 1 && valueForSearch.endsWith('"')
    valueForSearch = hasClosing
        ? valueForSearch.slice(1, -1)
        : valueForSearch.slice(1)
  }

  return {
    prefix,                                        // fully preserved left side
    active: { op, value: valueForSearch, raw: token },
    endsWithSpace: false
  }
}

function needsQuotes(v) {
  return /\s/.test(v) || /["]/.test(v)
}

// Is already wrapped with matching, unescaped double quotes?
function isSafelyDoubleQuoted(s) {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return false
  let bs = 0
  for (let i = s.length - 2; i >= 0 && s[i] === '\\'; i--) bs++
  return (bs % 2 === 0)
}

function quoteValue(v) {
  const s = String(v)
  if (isSafelyDoubleQuoted(s)) return s // note: return s, NOT `"${s}"`
  return `"${s.replace(/([\\"])/g, '\\$1')}"`
  // const safe = String(v).replace(/"/g, '\\"')
  // return `"${safe}"`
}

// Build final query string from prefix + op + value
function buildQuery(prefix, op, value) {
  const v = needsQuotes(value) ? quoteValue(value) : value
  if (op) return `${prefix}${op}:${v}`.trim()
  // If no op, default to tags for single-token accept? tweak if you want different default
  return `${prefix}tags:${v}`.trim()
}

// ---- helper for build the returns  ----
const perBucketLimit = (total, nBuckets, OPTS) =>
    Math.max(2, Math.min(OPTS.limitEachBucket || 5, Math.floor(total / Math.max(1, nBuckets))))

const pushTitleRows = (prefix, rows, out, OPTS) => {
  // direct: use book id, filter: search by field

  const searchType = prefix ? 'filter' : 'direct'

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    // Fuse: lower score is better; keep only strong matches
    if (r.score != null && r.score >= OPTS.minSuggestThreshold) continue

    // pick the best available field for display
    const it = r.item
    const field = it.title_jpn ? 'title_jpn'
        : it.title_raw ? 'title_raw'
            : 'filename'
    const val = field === 'filename' ? it.filename
        : field === 'title_jpn' ? it.title_jpn
            : it.title_raw
    if (!val) continue

    const label = field === 'filename' ? 'file'
        : field === 'title_jpn' ? 'title_jpn'
            : 'title'
    const display = buildDisplay(label, val, r, OPTS)
    out.push({
      label,
      value: val,
      display,
      query: buildQuery(prefix, label, val),
      score: r.score || 1,
      id: it._id,
      searchType
    })
  }
}

const pushValueRows = (prefix, rows, label, out, OPTS) => {
  // direct: use book id, filter: search by field
  const searchType = prefix ? 'filter' : 'direct'
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.score != null && r.score >= OPTS.minSuggestThreshold) continue
    const val = r.item.value
    if (!val) continue
    const display = buildDisplay(label, val, r, OPTS)
    out.push({
      label,
      value: val,
      display,
      query: buildQuery(prefix, label, val),
      score: r.score || 1,
      id: r.item?._id, // category & status have a list of id
      searchType,
    })
  }
}

function buildDisplay(label, val, r, OPTS) {
  const escapeHtml = (s) =>
      String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')

  const middleEllipsis = (s, max) => {
    s = String(s || '')
    if (s.length <= max) return escapeHtml(s)
    const keep = Math.max(4, Math.floor((max - 1) / 2))
    return escapeHtml(s.slice(0, keep)) + '…' + escapeHtml(s.slice(-keep))
  }
  // pull Fuse indices for this field/value
  const max = (OPTS && OPTS.maxSuggestLen) || 30
  let indices = null
  if (Array.isArray(r.matches)) {
    const m = r.matches.find(m =>
        (m.key && m.key.toLowerCase() === String(label).toLowerCase()) ||
        (typeof m.value === 'string' && m.value === val)
    )
    if (m && Array.isArray(m.indices)) indices = m.indices
  }
  const t = String(val || '')
  if (!t) return ''
  if (!indices || !indices.length) return middleEllipsis(t, max)

  // center a window around the first match
  const [s0, e0] = indices[0]       // Fuse gives inclusive [start, end]
  const mid = Math.floor((s0 + e0) / 2)
  const half = Math.max(10, Math.floor(max / 2))
  let start = Math.max(0, mid - half)
  let end = Math.min(t.length, start + max)
  if (end - start < max && start > 0) start = Math.max(0, end - max)

  const visible = t.slice(start, end)

  // shift & clamp all match ranges into the window
  const shifted = indices
      .map(([a, b]) => [a - start, b - start])
      .filter(([a, b]) => b >= 0 && a < visible.length)
      .map(([a, b]) => [Math.max(0, a), Math.min(visible.length - 1, b)])
      .sort((x, y) => x[0] - y[0])

  // merge overlaps
  const merged = []
  for (const rng of shifted) {
    if (!merged.length || rng[0] > merged[merged.length - 1][1] + 1) {
      merged.push(rng.slice())
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], rng[1])
    }
  }
  // stitch HTML with <mark>
  let html = ''
  let cur = 0
  for (const [a, b] of merged) {
    if (a > cur) html += escapeHtml(visible.slice(cur, a))
    html += '<mark>' + escapeHtml(visible.slice(a, b + 1)) + '</mark>'
    cur = b + 1
  }
  if (cur < visible.length) html += escapeHtml(visible.slice(cur))

  const leftEllip = start > 0 ? '…' : ''
  const rightEllip = end < t.length ? '…' : ''
  return leftEllip + html + rightEllip
}

/** ------------- execQuery Helpers -------------*/


// Translate friendly syntax -> liqe-compatible query
// Operators: + (AND), | (OR), unary - (NOT)
// Default scope (when no field is used): wrap bare terms/phrases as (title:... OR tags_flat:...)

const preprocessQuery = (input) => {
  let q = String(input || '')

  // 0) comparisons first
  q = q.replace(RE_TIME_CMP, (m, which, op, val) => {
    const field = ({ a: 'atime', m: 'mtime', p: 'ptime' })[which.toLowerCase()]
    return `${field}:${op}${val}`
  })


  // 1) pagediff shorthand
  q = q.replace(RE_PAGEDIFF, 'pagediff:>0')

  // 2) collapse bracket phrases only if needed
  if (/[{\[]/.test(q)) q = collapseBracketPhrases_quoteAware(q)

  // 3) split by quotes once
  const parts = q.split(RE_QUOTE_SPLIT)

  // 4) normalize operators / unary minus in non-quoted chunks
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue // skip quoted
    let chunk = parts[i]
    chunk = chunk
        .replace(RE_OP_PLUS_MID, ' AND ')
        .replace(RE_OP_PIPE_MID, ' OR ')
        .replace(RE_OP_TRAIL_PLUS, ' AND ')
        .replace(RE_OP_TRAIL_PIPE, ' OR ')
        .replace(RE_OP_LEAD_PLUS, '$1AND ')
        .replace(RE_OP_LEAD_PIPE, '$1OR ')
        .replace(RE_UNARY_MINUS, '$1NOT ')
        .replace(RE_UNARY_MINUS_TRAIL, '$1NOT ')
        .replace(/\s{2,}/g, ' ')
    parts[i] = chunk
  }

  // 4.5) Quote a leading bare token if it starts with a digit (applies to the whole query head only)
  // e.g., "4abc def" -> "\"4abc\" def"
  if (parts.length > 0) {
    parts[0] = parts[0].replace(
        /^\s*(-?)(\d[^\s)]*)/,               // don't eat closing parens
        (m, neg, tok) => `${neg}"${tok}"`
    )
  }

  // 5) normalize single quotes to double quotes (quoted parts only)
  for (let i = 1; i < parts.length; i += 2) {
    const seg = parts[i]
    if (seg.startsWith('\'') && seg.endsWith('\'')) {
      parts[i] = `"${seg.slice(1, -1).replace(/"/g, '\\"')}"`
    }
  }

  // 6) rejoin once
  q = parts.join(' ')

  // 7) field remapping / cleanup
  q = q
      .replace(RE_REMOVE_SPACE_BEFORE_QUOTE, ':')
      .replace(RE_FIELD_REM_TAG, 'tags_flat:')
      .replace(RE_FIELD_COLON_SPACE, '$1:')
      .replace(RE_FIELD_COLON_ANY, (m, field) => {
        const f = field.toLowerCase()
        if (RESERVED.has(f)) return `${f}:`
        return `tags.${f}:`
      })

  // 7.5) Auto-quote scope values that start with a digit, except *time/pagediff fields
  // - Skips values already starting with " or / (quotes/regex)
  // - Keeps values without spaces as-is unless they start with a digit
  q = q.replace(
      /(\b[^\s:()]+):(?!["/])([^\s)]+)/g,     // field:value (no spaces, not already quoted/regex)
      (m, field, val) => {
        const f = field.toLowerCase()
        // don't quote time-like or pagediff scopes
        if (/(?:^|\.)(?:atime|mtime|ptime|time)$/.test(f) || /(?:^|\.)(?:pagediff)$/.test(f)) return m
        if (/^\d/.test(val)) return `${field}:"${val}"`
        return m
      }
  )

  // 8) time value coercion
  q = q.replace(RE_TIME_CANON, (m, fld, op, val) => {
    const expanded = expandDateComparison(fld.toLowerCase(), op, val)
    if (expanded) return expanded
    if (/^\d{13}$/.test(val)) return `${fld}:${op}${Math.floor(Number(val) / 1000)}`
    if (/^\d{10}$/.test(val)) return `${fld}:${op}${Number(val)}`
    return m
  })
  // 9) default scope expansion (only if no explicit field anywhere)
  if (!RE_HAS_FIELD.test(q)) {
    // reuse the already tokenized parts to avoid splitting again
    const out = []
    for (let i = 0; i < parts.length; i++) {
      const isQuoted = i % 2 === 1
      const seg = parts[i]
      if (isQuoted) {
        out.push(`(title:${seg} OR tags_flat:${seg})`)
      } else if (seg.trim()) {
        // wrap bare tokens; keep boolean words and parens
        out.push(
            seg.replace(/(?:^|(?<=\s))(-?)([^\s()]+)(?=\s|$)/g, (m, neg, tok) => {
              if (/^(AND|OR|NOT)$/i.test(tok)) return m
              if (/^[()]+$/.test(tok)) return m
              return `${neg}(title:${tok} OR tags_flat:${tok})`
            })
        )
      }
    }
    q = out.join(' ')
  }

  return q.trim()
}
// --- helpers parsing query
// Hoisted regexes (compile once)
const RE_TIME_CMP = /\b([amp]time)\s*([<>]=?|=)\s*([^\s)]+)/gi
const RE_PAGEDIFF = /(?:^|(?<=\s))pagediff(?=\s|$)/gi
const RE_QUOTE_SPLIT = /(".*?"|'.*?')/g
const RE_OP_PLUS_MID = /(?<=\S)\s*\+\s*(?=\S)/g
const RE_OP_PIPE_MID = /(?<=\S)\s*\|\s*(?=\S)/g
const RE_OP_TRAIL_PLUS = /\+\s*$/g
const RE_OP_TRAIL_PIPE = /\|\s*$/g
const RE_OP_LEAD_PLUS = /(^|[\s(])\+\s*/g
const RE_OP_LEAD_PIPE = /(^|[\s(])\|\s*/g
const RE_UNARY_MINUS = /(^|[\s(])-\s*(?=(\(|"|'|[^\s()]+))/g
const RE_UNARY_MINUS_TRAIL = /(^|[\s(])-\s*$/g
const RE_FIELD_REM_TAG = /\b(tags?)\s*:/gi
const RE_FIELD_COLON_SPACE = /\b([a-zA-Z][\w-]{0,30})\s*:\s+(?=\S)/g
const RE_FIELD_COLON_ANY = /\b([a-zA-Z][\w-]{0,30})\s*:/g
const RE_REMOVE_SPACE_BEFORE_QUOTE = /:\s+(?=["'])/g
const RE_HAS_FIELD = /\b[a-zA-Z][\w-]{0,30}\s*:/
const RE_TIME_CANON = /\b([map]time)\s*:\s*([<>]=?|=)\s*([^\s)]+)\b/gi

const BRACKET_PAIRS = {
  '[': ']', '{': '}',        // ASCII
  '［': '］', '｛': '｝',       // Fullwidth square/curly
  '（': '）',                         // Fullwidth parentheses (safe: your boolean grammar uses ASCII ())
  '「': '」', '『': '』',       // Corner / White corner
  '【': '】', '〔': '〕',       // Lenticular / Tortoise shell
  '《': '》', '〈': '〉',       // Angle / Single angle
  '〖': '〗', '〘': '〙',       // Black lenticular / White tortoise shell
  '〚': '〛',                         // White square bracket
}

// Build a fast opener-detect regex from the keys
function reOpenersFromPairs(pairs) {
  const esc = s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const openers = Object.keys(pairs).map(esc).join('')
  return new RegExp('[' + openers + ']')
}

const RE_ANY_OPENER = reOpenersFromPairs(BRACKET_PAIRS)


// Quote-aware collapse that only processes non-quoted chunks
function collapseBracketsInPlainText(s) {
  const pairs = BRACKET_PAIRS
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    const close = pairs[ch]
    if (!close) {
      out += ch
      i++
      continue
    }

    // Scan forward until matching closer for *this* opener.
    // Supports simple nesting of the same bracket type.
    let j = i + 1, depth = 1
    while (j < s.length && depth > 0) {
      const cj = s[j]
      if (cj === ch) depth++
      else if (cj === close) depth--
      j++
    }
    if (depth === 0) {
      const innerRaw = s.slice(i + 1, j - 1)           // preserve spaces exactly
      const innerEsc = innerRaw.replace(/"/g, '\\"')    // escape "
      out += `"${innerEsc}"`
      i = j
    } else {
      // Unmatched opener → emit literally
      out += ch
      i++
    }
  }
  return out
}

function collapseBracketPhrases_quoteAware(q) {
  const parts = q.split(/(".*?"|'.*?')/g)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue                 // skip quoted
    if (!RE_ANY_OPENER.test(parts[i])) continue
    parts[i] = collapseBracketsInPlainText(parts[i])
  }
  return parts.join('')
}

// --- helpers for YYYY / YYYY-MM / YYYY-MM-DD -> epoch ranges (UTC) ---
function toSec(x) {
  if (x == null) return 0

  // Numbers: detect ms vs s
  if (typeof x === 'number' && isFinite(x)) {
    return x >= 1e12 ? Math.floor(x / 1000) : Math.floor(x)
  }

  // Strings: trim, check digits, else parse as ISO
  const s = String(x).trim()
  if (!s) return 0
  if (/^\d{13}$/.test(s)) return Math.floor(Number(s) / 1000)  // ms -> s
  if (/^\d{10}$/.test(s)) return Number(s)                      // already seconds

  // ISO 8601: Date.parse returns ms since epoch; 'Z' means UTC
  const t = Date.parse(s)   // e.g., "2000-01-01T15:38:44.593Z"
  return isNaN(t) ? 0 : Math.floor(t / 1000)
}

function rangeFromYmdLike(s) {
  // YYYY
  let m = /^(\d{4})$/.exec(s)
  if (m) {
    const y = +m[1]
    return { start: Date.UTC(y, 0, 1) / 1000, end: Date.UTC(y + 1, 0, 1) / 1000 }
  }
  // YYYY-MM
  m = /^(\d{4})-(\d{2})$/.exec(s)
  if (m) {
    const y = +m[1], mon = +m[2] - 1
    return { start: Date.UTC(y, mon, 1) / 1000, end: Date.UTC(y, mon + 1, 1) / 1000 }
  }
  // YYYY-MM-DD
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    const y = +m[1], mon = +m[2] - 1, d = +m[3]
    return { start: Date.UTC(y, mon, d) / 1000, end: Date.UTC(y, mon, d + 1) / 1000 }
  }
  return null
}

function expandDateComparison(field, op, val) {
  const r = rangeFromYmdLike(val)
  if (!r) return null
  const { start, end } = r
  switch (op) {
    case '=':
      return `(${field}:>=${start} AND ${field}:<${end})` // whole unit
    case '>':
      return `${field}:>=${end}`                           // strictly after unit
    case '>=':
      return `${field}:>=${start}`                         // from unit start
    case '<':
      return `${field}:<${start}`                          // strictly before unit
    case '<=':
      return `${field}:<${end}`                            // up to unit end
    default:
      return null
  }
}

/** ------------- String Helpers -------------*/
const normStr = (s) => (s == null ? '' : String(s).toLowerCase().trim())


// Reverse map: alias -> canonical
const ALIAS_TO_CANON = Object.fromEntries(
    Object.entries(OP_ALIASES).flatMap(([canon, aliases]) => aliases.map(a => [a, canon]))
)
// Which operators require a non-empty term
const REQUIRES_TERM = new Set(Object.keys(OP_ALIASES))

const OP_REGEX = /^([^:]+)\s*:\s*(.*)$/


function parseScopedQuery(raw) {
  const m = OP_REGEX.exec(raw)
  if (m) {
    const [, alias, tail] = m
    const op = normalizeOp(alias)
    return { op, query: (tail || '').trim() }
  }
  return { op: null, query: raw.trim() }
}

function replaceAliasScop(raw) {
  const m = OP_REGEX.exec(raw)
  if (m) {
    const [, alias, tail] = m
    const op = ALIAS_TO_CANON[alias] || alias // normalizeOp(alias)
    return `${op}:${tail}`
  }
  return raw
}


// Normalize the parsed operator
function normalizeOp(opRaw) {
  if (!opRaw) return null
  const k = opRaw.toLowerCase()
  return ALIAS_TO_CANON[k] || k
}

const getBasename = (filepath) => {
  const t = normStr(filepath)
  if (!t) return ''
  const parts = t.split(/[/\\]+/)
  return parts[parts.length - 1] || ''
}

/** An example of a book in this.bookList
 *
 * */
// const book = {
//   'id': '',
//   'hash': '',
//   'coverPath': '',
//   'filepath': '',
//   'type': '',
//   'pageCount': 1,
//   'bundleSize': 1,
//   'mtime': '',
//   'coverHash': '',
//   'hiddenBook': 0,
//   'readCount': 0,
//   'exist': true,
//   'date': 1,
//   'title': '',
//   'status': '',
//   'rating': 1,
//   'tags': {
//     'language': [''],
//     'artist': [''],
//     'male': [''],
//     'female': [''],
//     'mixed': [''],
//     'parody': [],
//     'character': [],
//     'group': [],
//     'other': [],
//     'cosplayer': []
//   },
//   'title_jpn': '',
//   'filecount': 1,
//   'posted': 1,
//   'filesize': 1,
//   'category': '',
//   'url': '',
//   'mark': 0,
//   'createdAt': '',
//   'updatedAt': ''
// }
