import Fuse from 'fuse.js'
import { useAppStore } from '../pinia.js'
import { parse as liqeParse, filter as liqeFilter } from 'liqe'

//    keep reserved fields; everything else map to tags.<field>:
const RESERVED = new Set(['title', 'mtime', 'atime', 'ptime',
  'pagediff', 'status', 'category', 'tags_flat',
  // 'artist', 'group', 'parody'
])
// operators
const OP_ALIASES = {
  title: ['title', 't'],
  tag: ['tag', 'tags'],
  artist: ['artist', 'a'],
  group: ['group', 'g'],
  parody: ['parody', 'p'],
  category: ['category', 'cat'],
  status: ['status'],
}
// scope
// additional subcategories for tags; all other subcategories are flatted into tags_flat
// but the user can still search for them directly
// const TAG_SUBCATEGORY = ['artist', 'parody', 'group']
// update extraAttrsOptions if changed
const BOOK_EXTRA_ATTRS = ['category', 'status']

// fuse options
const DEFAULT_OPTS = {
  threshold: 0.6,           // 0.0 strict … 1.0 very fuzzy
  minSuggestThreshold: 0.6, // lower means more restrictive
  minRunTitleScore: 0.5,
  distance: 150,
  ignoreLocation: true,
  limitSuggest: 10,
  limitEverything: 20, // TODO check
  limitEachBucket: 5,  // suggestions split across Title/Tag/Everything
  weightTitle: 1,
  weightTitleJpn: 1,
  weightTitleFilename: 1,
  weightEverything: { title: 1, title_jpn: 1, tags_flat: 1 },
}

/**
 * Factory for Fuse-powered search across bookList.
 *  * Book shape (relevant fields):
 *   {
 *     title: string,
 *     title_jpn: string,
 *     tags: { [namespace: string]: string[] }  // e.g., language/artist/male/female/...
 *   }
 * Currently support for searching by title, title_jpn, and tags,
 * API:
 *   const s = makeFuseSearch(bookList, opts?)
 *   s.suggest(q, limit?) -> [{ label, value, kind, id? }]
 *   s.run({ kind, value, id, limit? }) -> { mode, query, results }
 *   s.rebuild(nextBookList) -> void
 */
// TODO: fix execquery: why artist:4why is not working
// FIXME: the default tag: () should include everything
export function makeFuseSearch(initialBookList = [], userOpts = {}) {

  const { statusOption, categoryOption, } = useAppStore()

  // ---- options ----
  const OPTS = {
    ...DEFAULT_OPTS,
    ...userOpts,
  }

  // ---- internal state ----
  let bookList = Array.isArray(initialBookList) ? initialBookList : []
  let fuseExtraAttrs = {} // for category, status
  let fuseTitles = null
  let fuseTags = null
  let fuseTagSub = {}
  let extraAttrsDoc = {}
  const extraAttrs = BOOK_EXTRA_ATTRS
  let docs = bookList.map(b => toDoc(b))
  const tagSub = [...new Set(docs.flatMap(b => Object.keys(b.tags)))]  //TAG_SUBCATEGORY

  let byId = new Map(bookList.map(b => [b.id, b]))
  // let fullDocs = []

  // ---- helpers ----


  function buildIndexes() {
    // 0) preconditions
    if (!Array.isArray(docs)) docs = []
    const mkFuse = (list, keys, extra = {}) =>
        new Fuse(list, {
          includeScore: true,
          includeMatches: true,
          shouldSort: true,
          ignoreLocation: true,
          threshold: OPTS.threshold,
          distance: OPTS.distance,
          keys,
          ...extra,
        })

    // 1) Titles index (use docs directly)
    const titleDocs = []
    for (const d of docs) {
      const tr = normStr(d.__book.title)
      const tj = normStr(d.__book.title_jpn)
      const fn = getBasename(d.__book.filepath)
      if (!tr && !tj && !fn) continue             // ← keep if any present
      titleDocs.push({ _id: d._id, title_raw: tr, title_jpn: tj, filename: fn })
    }
    fuseTitles = mkFuse(titleDocs, [
      { name: 'title_raw', weight: OPTS.weightTitle },
      { name: 'title_jpn', weight: OPTS.weightTitleJpn },
      { name: 'filename', weight: OPTS.weightTitleFilename }
    ])

    // 2) Tags (unique strings) from docs.tags_flat
    const uniqueTags = Array.from(new Set(docs.flatMap(d => d.tags_flat || [])))
    const tagDocs = uniqueTags.map(v => ({ value: v }))
    fuseTags = mkFuse(tagDocs, ['value'])

    // 3) Tag subcategories (unique strings per subcat)
    const tagSubSet = Object.fromEntries(tagSub.map(k => [k, new Set()]))
    for (const d of docs) {
      const t = d.tags || {}
      for (const k of tagSub) {
        const arr = t[k] || []
        for (const v of arr) tagSubSet[k].add(v)
      }
    }
    const tagSubDoc = Object.fromEntries(
        tagSub.map(k => [k, Array.from(tagSubSet[k]).map(v => ({ value: v }))])
    )
    fuseTagSub = Object.fromEntries(
        tagSub.map(k => [k, mkFuse(tagSubDoc[k], ['value'])])
    )

    // 4) Extra attributes (status/category) buckets built from docs
    const extraKeyVals = {
      status: Array.from(new Set(statusOption.filter(Boolean))),
      category: Array.from(new Set(categoryOption.filter(Boolean))),
    }
    extraAttrsDoc = Object.fromEntries(
        extraAttrs.map(key => [key, Object.fromEntries(extraKeyVals[key].map(v => [v, []]))])
    )
    for (const d of docs) {
      for (const key of extraAttrs) {
        const v = String(d[key] ?? '')
        if (!v) continue
        if (!extraAttrsDoc[key][v]) extraAttrsDoc[key][v] = []
        extraAttrsDoc[key][v].push({ _id: d._id })
      }
    }
    fuseExtraAttrs = Object.fromEntries(
        extraAttrs.map(key => [key, mkFuse(
            Object.keys(extraAttrsDoc[key]).map(value => ({ value })), ['value']
        )])
    )
  }

  // initial build
  buildIndexes()

  // ---- public: suggestions for <el-autocomplete> ----
  function suggest(q, limit = OPTS.limitSuggest) {
    const raw = normStr(q)
    if (!raw) return []

    // Multi-scope awareness
    const { prefix, active, endsWithSpace } = getActiveToken(raw)

    // console.log(`prefix: ${prefix}, active: ${active}, endsWithSpace: ${endsWithSpace}`)
    // Parse quick scope hint like "title:", "tag:", "artist:", etc.
    // If we do have an active scope, use that. Otherwise, fall back to single-scope quick-hint.
    // (This preserves your existing behavior for simple inputs like "title:abc".)
    let op, query
    if (active) {
      op = active.op
      query = String(active.value || '').trim()
    } else {
      // keeps support for "quick scope hint" when there's only one or none
      const scoped = parseScopedQuery(raw)
      op = scoped.op
      query = scoped.query
    }
    if (op && REQUIRES_TERM.has(op) && !query) return []

    const perType = Math.max(3, Math.min(OPTS.limitEachBucket, Math.floor(limit / 3)))
    const out = []

    // Helper to push suggestion rows
    const pushRows = (rows, label) => {
      if (label === 'title') {
        for (const r of rows) {
          if (r.score >= OPTS.minSuggestThreshold) continue
          const field = r.item.title_jpn ? 'title_jpn'
              : r.item.title_raw ? 'title_raw'
                  : 'filename'
          const val = field === 'filename' ? r.item.filename
              : field === 'title_jpn' ? r.item.title_jpn
                  : r.item.title_raw
          if (!val) continue  // guard against empty strings
          const label = field === 'filename' ? 'file'
              : field === 'title_jpn' ? 'title_jpn'
                  : 'title'
          out.push({
            label, // the left part of the suggestion list in the dropdown
            value: val, // the right part
            // query: `title:${val}`,
            // If we have an active scope, always rebuild as prefix + "op:val".
            // If no active scope (unscoped), your previous behavior kept `title:val` too.
            // query: `${prefix}${op ? `${op}:${val}` : `title:${val}`}`.trim(),
            query: buildQuery(prefix, label, val),
            score: r.score || 1,
            id: r.item._id
          })
        }
      } else {
        for (const r of rows) {
          if (r.score >= OPTS.minSuggestThreshold) continue
          const val = r.item.value
          console.log('prefix', prefix, 'op', op, 'val', val)
          out.push({
            label,
            value: val,
            score: r.score || 1,
            // we keep tags: ponytail as other subcategories may share the same value
            // query: `${label}:${r.item.value}`,
            // query: `${prefix}${label}:${r.item.value}`.trim(),
            query: buildQuery(prefix, label, val),

            id: null,  // only clicking a title in the suggestion list gets the book id
          })
        }
      }
    }

    // If scoped, hit only that index; else do title + (tags + extras sample)
    if (op === 'title' && fuseTitles) {
      pushRows(fuseTitles.search(query, { limit }), 'title')
      // search all tags
    } else if ((op === 'tag' || op === 'tags') && fuseTags) {
      pushRows(fuseTags.search(query, { limit }), 'tags')
      // search one tag subcategory
    } else if (tagSub.includes(op) && fuseTagSub[op]) {
      pushRows(fuseTagSub[op].search(query, { limit }), op,)
      // search one extra attribute, e.g. status/category
    } else if (extraAttrs.includes(op) && fuseExtraAttrs[op]) {
      pushRows(fuseExtraAttrs[op].search(query, { limit }), op)
    } else {
      // Unscoped: combine top-N from each bucket (balanced)
      if (fuseTitles) pushRows(fuseTitles.search(query, { limit: perType }), 'title')
      if (fuseTags) pushRows(fuseTags.search(query, { limit: perType }), 'tags')
      for (const k of extraAttrs) {
        if (fuseExtraAttrs[k]) pushRows(fuseExtraAttrs[k].search(query, { limit: perType }), k)
      }
      // (Optional) also sample a subcategory that looks promising:
      // (should we include subcategories given it is a general search ? )
      // for (const k of tagSub) {
      //   if (fuseTagSub[k]) pushRows(fuseTagSub[k].search(query, { limit: 2 }), `${k}`)
      // }
    }

    // de-dup by (kind|value|id)
    const seen = new Set()
    const deduped = []
    for (const item of out) {
      const key = `${item.label}|${item.value}|${item?.id ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(item)
      }
    }
    return deduped.sort((a, b) => a.score - b.score).slice(0, limit)
  }


  // ---- public: run a search; returns an array of original book objects ---
  // fix search with group:bad mushrooms work, but group:"bad mushrooms" doesn't"
  function execQuery({ value = '', id = null } = {}) {
    // console.log('run: ', 'mtime:', docs[2].mtime, 'atime:', docs[2].atime, 'ptime:', docs[2].ptime,)
    // console.log('mtime:', bookList[0].mtime)

    if (id) {
      console.log('run: ', 'id: ', id)
      return { mode: 'book id', results: [byId.get(id)] }
    }


    let raw = String(value || '').trim()

    if (!raw) return []
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
  function rebuild(nextBookList = []) {
    bookList = Array.isArray(nextBookList) ? nextBookList : []
    buildIndexes()
  }

  return { suggest, execQuery, rebuild }

}

/** ------------- Suggest Helpers -------------*/
// --- helpers: multi-scope parsing ---
// Return { prefix, active: { op, value, raw }, endsWithSpace }
// - prefix: everything before the active token, ending with exactly one space (if anything exists)
// - active.op: normalized op if the active token has "field:", else null
// - active.value: the (possibly partial) value after the colon (quotes stripped if present)
// - If the input ends with a space, active = null and prefix = raw (normalized to one trailing space).
function getActiveToken(raw) {
  const s = String(raw || '')
  if (!s) return { prefix: '', active: null, endsWithSpace: false }

  // 1) If trailing spaces, there is no active token—start a new one after prefix.
  const endsWithSpace = /\s$/.test(s)
  if (endsWithSpace) {
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

function quoteValue(v) {
  const safe = String(v).replace(/"/g, '\\"')
  return `"${safe}"`
}

// Build final query string from prefix + op + value
function buildQuery(prefix, op, value) {
  const v = needsQuotes(value) ? quoteValue(value) : value
  if (op) return `${prefix}${op}:${v}`.trim()
  // If no op, default to tags for single-token accept? tweak if you want different default
  return `${prefix}tags:${v}`.trim()
}

/** ------------- execQuery Helpers -------------*/

// Build a liqe-friendly doc from a book. We keep a pointer back to the original.
const toDoc = (b) => {
  const title = [b.title, b.title_jpn, getBasename(b.filepath)].filter(Boolean).join(' ').trim()
  const tagsObj = (b.tags && typeof b.tags === 'object') ? b.tags : {}
  const tags = {}
  const tags_flat = []

  for (const [cat, vals] of Object.entries(tagsObj)) {
    const arr = Array.isArray(vals) ? vals : [vals]
    const norm = arr.map(normStr).filter(Boolean)
    if (norm.length) {
      const key = String(cat).toLowerCase()
      tags[key] = norm
      tags_flat.push(...norm)
    }
  }

  return {
    _id: b.id,
    __book: b,                              // back-reference
    title,                                  // reserved title field
    tags,                                   // nested categories: tags.female, tags.artist, ...
    tags_flat,                              // for tag:/tags: lookups across all subcategories
    mtime: toSec(b?.mtime) || 0,       // string e.g. 2000-01-01T15:38:44.593Z
    atime: toSec(b?.date) || 0,        // integers
    ptime: toSec(b?.posted) || 0,     // integers
    pagediff: Number(b.pageDiff ?? 0) || 0, // page difference metric (number)
    // you can add more searchable fields here (status, category, etc.) if needed
    status: b.status ?? '',
    category: b.category ?? '',
    // artist: b?.tags?.artist ?? [],
    // group: b?.tags?.group ?? [],
    // parody: b?.tags?.parody ?? [],
  }
}


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
    const op = normalizeOp(alias)
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
