/** Normalize titles for full test search in sqlite (fts5)
 * */

const {
  loadDefaultJapaneseParser,
  loadDefaultSimplifiedChineseParser,
  loadDefaultTraditionalChineseParser
} = require('budoux')
// to segment words
const ja = loadDefaultJapaneseParser()
const zhHans = loadDefaultSimplifiedChineseParser()
const zhHant = loadDefaultTraditionalChineseParser()


// -------------------- Main --------------------
const path = require('path')

//   Need to ensure the title_raw is a file name, not a path
function normalizeTitle(title_raw) {
  if (!title_raw || !String(title_raw).trim()) {
    return {
      title_raw,
      title_full_norm: '',
      title_core_norm: '',
      title_core_norm_seg: '',
      title_core: '',
      vol_num: null,
      vol_set: null,
      vol_conf: 0,
      edition_bits: 0,
      nums_all: [],
      nums_required: []
    }
  }

  // ---------------- 0) Normalize base string ----------------
  let s = String(title_raw).toLowerCase()
  s = s.normalize('NFKC')
  s = removeFileExtension(s)
  s = zenkakuToHankaku(s)
  s = unifyPunct(s).trim()
  // s = normalizeSpaces(s)
  s = normalizeBrackets(s)
  //

  // Keep a copy before removing blocks
  const originalNorm = s

  // ---------------- 1) Remove release/scan blocks ([],()) at tail & known noise words ----------------
  const { stripped, removedBlocks } = stripReleaseNoiseBlocks(s)
  s = stripped

  // title_full_norm: a lightly cleaned version that callers can display or log
  const title_full_norm = originalNorm

  // title_core_norm: remove inner bracket content (not only trailing) + collapse spaces
  // const title_core_norm = removeAllBracketContent(sNumNormRoman).replace(/\s+/g, ' ').trim()
  const title_core_norm = removeBrackets(s).replace(/\s+/g, ' ').trim()
  // segment for FTS (budoux parsers already loaded above)
  const title_core_norm_seg = segmentForFts(title_core_norm)

  // get all numbers

  const sNumNorm = normalizeJPZHNumerals(title_core_norm) // kanji → arabic
  // roman → arabic only when near structural markers
  const sNumNormRoman = normalizeRomanNumeralsWithContext(sNumNorm)
  const nums_all = extractNumericTokens(sNumNormRoman)
  const title_core = sNumNormRoman.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim()


  // Final shape (backward compatible + new fields)
  return {
    title_raw,
    title_full_norm,
    title_core_norm,
    title_core_norm_seg,
    title_core,
    nums_all,
  }
}


// -------------------- Low-level helpers for words and punctuations --------------------
// Plain JS, safe for mixed/dirty inputs from DB
function removeFileExtension(s) {
  // Longest-first so ".tar.gz" matches before ".gz"
  const exts = [
    '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.lzma', '.tar.lz', '.tar.br',
    '.tbz2', '.tgz', '.txz', '.tzst',

    // common archives
    '.zip', '.rar', '.7z', '.gz', '.bz2', '.xz', '.zst', '.lzma', '.lz', '.br',

    // comic/book archives
    '.cbz', '.cbr', '.cb7', '.cbt', '.cba',

    // package/container formats often treated like archives
    '.jar', '.war', '.apk', '.ipa', '.cab', '.ar', '.cpio', '.z',
    '.deb', '.rpm', '.pkg', '.whl', '.egg', '.msi'
  ]

  const lower = s.toLowerCase()
  for (const ext of exts) {
    if (lower.endsWith(ext)) {
      const base = s.slice(0, s.length - ext.length)
      // If a trailing dot remains (e.g., "name."), trim it.
      return base.replace(/\.$/, '')
    }
  }
  // Not a compressed/archive filename -> leave unchanged
  return s
}

function _removeFileExtension(s) {
  return path.parse(s).name
}


function zenkakuToHankaku(str) {
  // converts full-width ASCII to half-width; leaves kana as-is
  return str.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
}

function unifyPunct(str) {
  return str
      // dashes → hyphen
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')    // ZWSP, ZWNJ, WJ, BOM
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ') // NBSP & wide spaces

      .replace(/[\u2012\u2013\u2014\u2015\u2212]/g, '-')
      // quotes → ASCII
      .replace(/[«»„“”‟”〝〞]/g, '"')
      .replace(/[‘’‚‛]/g, '\'')
      // ellipses → "..."
      .replace(/[\u2026\u22EF]/g, '...')
      // middle dots → space
      .replace(/[・･·•●]/g, ' ')
      // tildes → "~"
      .replace(/[～〜]/g, '~')
      // bullets etc → space
      .replace(/[•◦▪︎●]/g, ' ')
      // slashes variants → /
      .replace(/[＼﹨∕]/g, '/')
      // backslash variants → \
      .replace(/[﹨]/g, '\\')
      // unify stars to plain '*'
      .replace(/[✱✲✳✴✵✶✷✸✹✺✻✼✽✾]/g, '*')
}


// Captures the final trailing bracket block (with nesting) if present.
// Returns { content, start, end } or null.
function captureTrailingBracketBlock(s) {
  let i = s.length - 1
  // Skip trailing whitespace
  while (i >= 0 && /\s/.test(s[i])) i--
  if (i < 0) return null

  const close = s[i]
  if (close !== ')' && close !== ']') return null

  const wantOpen = close === ')' ? '(' : ']'
  let depth = 0
  let end = i

  // Walk backward to find the matching opener with nesting awareness
  for (; i >= 0; i--) {
    const ch = s[i]
    if (ch === close) depth++
    else if (ch === wantOpen) depth--
    if (depth === 0) {
      const start = i
      const inner = s.slice(start + 1, end) // content without the outer brackets
      return { content: inner, start, end: end + 1 }
    }
  }
  return null // malformed/unbalanced
}


// -------------------------------------------------
// Remove trailing release/scan/group/language blocks like "[Digital] (ENG) [Group]" at the tail.
// Returns { stripped, removedBlocks[] }
function stripReleaseNoiseBlocks(s) {
  const removedBlocks = []
  let out = s
  // Strip up to 3 noisy trailing blocks
  for (let i = 0; i < 3; i++) {
    const tail = captureTrailingBracketBlock(out)
    if (!tail) break
    const c = tail.content.trim()
    // Heuristics: common release words → treat as noise
    if (/\b(digital|webrip|web|kobo|kindle|scans?|raw|uncensored|無修正|修正版|dl版|complete|全集|完全版|翻訳|英訳|中文|汉化|漢化|繁体中文|簡体中文|個人漢化|个人汉化)\b/i.test(c)) {
      removedBlocks.push(c)
      out = (out.slice(0, tail.start) + out.slice(tail.end)).trim()
      continue
    }
    // If block looks like pure language tag or group tag, also strip
    if (/^(eng|en|jp|ja|zh|chs|cht|sc|tc|cn|tw|kr|ko)$/i.test(c) || /\b(group|team|tl|ts|rip)\b/i.test(c)) {
      removedBlocks.push(c)
      out = (out.slice(0, tail.start) + out.slice(tail.end)).trim()
      continue
    }
    break
  }
  // Also strip known leading/trailing noise tokens
  out = out.replace(/\b(digital|webrip|web|raw)\b/g, '').replace(/\s+/g, ' ').trim()
  return { stripped: out, removedBlocks }
}

// Convert JP/ZH numerals to arabic digits (一二三四五六七八九十百千〇零 → 0-9...).
function normalizeJPZHNumerals(s) {
  // very small mapper for common numerals; keeps multi-digit logic simple
  const map = {
    '零': '0',
    '〇': '0',
    '一': '1',
    '二': '2',
    '三': '3',
    '四': '4',
    '五': '5',
    '六': '6',
    '七': '7',
    '八': '8',
    '九': '9'
  }
  // Replace kanji digits directly; for 十/百/千 we do a weak normalization: 十→10 (only when isolated or followed by digit)
  let out = s.replace(/[零〇一二三四五六七八九]/g, ch => map[ch] || ch)
  // Simple tens/hundreds: 十[0-9]? → "10" + digit, 百→"100", 千→"1000" when used alone or followed by delimiter/digit
  out = out
      .replace(/(?<![\p{L}\p{N}])十(?![\p{L}])/gu, '10')
      .replace(/(?<![\p{L}\p{N}])百(?![\p{L}])/gu, '100')
      .replace(/(?<![\p{L}\p{N}])千(?![\p{L}])/gu, '1000')
  return out
}

// Convert roman numerals to arabic only near Part/Vol/Season markers
// If you already have romanToInt(rn), keep it. Otherwise plug yours in.
function intToRoman(num) {
  if (!Number.isFinite(num) || num <= 0 || num >= 4000) return null
  const table = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
  ]
  let n = num, out = ''
  for (const [v, sym] of table) while (n >= v) {
    out += sym
    n -= v
  }
  return out
}

function isValidRomanToken(rn, maxVal = 3999) {
  const v = romanToInt(rn)
  if (v == null || v <= 0 || v > maxVal) return false
  return intToRoman(v).toUpperCase() === rn.toUpperCase()
}

function normalizeUnicodeRomansToASCII(s) {
  const map = {
    'Ⅰ': 'I',
    'Ⅱ': 'II',
    'Ⅲ': 'III',
    'Ⅳ': 'IV',
    'Ⅴ': 'V',
    'Ⅵ': 'VI',
    'Ⅶ': 'VII',
    'Ⅷ': 'VIII',
    'Ⅸ': 'IX',
    'Ⅹ': 'X',
    'Ⅺ': 'XI',
    'Ⅻ': 'XII',
    'Ⅼ': 'L',
    'Ⅽ': 'C',
    'Ⅾ': 'D',
    'Ⅿ': 'M',
    'ⅰ': 'I',
    'ⅱ': 'II',
    'ⅲ': 'III',
    'ⅳ': 'IV',
    'ⅴ': 'V',
    'ⅵ': 'VI',
    'ⅶ': 'VII',
    'ⅷ': 'VIII',
    'ⅸ': 'IX',
    'ⅹ': 'X',
    'ⅼ': 'L',
    'ⅽ': 'C',
    'ⅾ': 'D',
    'ⅿ': 'M'
  }
  return s.replace(/[\u2160-\u217F]/g, ch => map[ch] || ch)
}

/**
 * Convert Roman numerals to Arabic wherever they appear as standalone tokens.
 * "Standalone" = not adjacent to ASCII letters, so CJK text like "第Ⅳ巻" still works.
 * Examples:
 *   "Title II" → "Title 2"
 *   "[III]" → "[3]"
 *   "第Ⅳ巻" → "第4巻"  (after Unicode normalization here)
 */
function normalizeRomanNumeralsWithContext(s) {
  if (!s) return s
  // 1) Normalize Unicode Roman glyphs first
  let out = normalizeUnicodeRomansToASCII(s)

  // 2) Replace standalone ASCII roman tokens (case-insensitive)
  // Not using \b because it fails with CJK; instead forbid adjacency with [A-Za-z].
  const rnToken = /(?<![A-Za-z])([ivxlcdm]{1,7})(?![A-Za-z])/gi

  out = out.replace(rnToken, (m, rn) => {
    return isValidRomanToken(rn) ? String(romanToInt(rn)) : m
  })

  return out
}


function romanToInt(rn) {
  const map = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
  let sum = 0, prev = 0
  for (let i = rn.length - 1; i >= 0; i--) {
    const val = map[rn[i]]
    if (!val) return null
    if (val < prev) {
      sum -= val
    } else {sum += val}
    prev = val
  }
  return sum || null
}

// -----   Remove ALL bracketed content, not just trailing
// full/half-width style brackets we normalize into () or []
const BRACKET_PAIRS = [
  ['「', '」'], ['『', '』'], ['【', '】'], ['〔', '〕'], ['（', '）'], ['《', '》'], ['〈', '〉'],
  ['｛', '｝'], ['{', '}'], ['［', '］'], ['＜', '＞'], ['﴾', '﴿'],
]

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function normalizeBrackets(str) {
  let out = str
  for (const [l, r] of BRACKET_PAIRS) {
    const open = (l === '【' || l === '［' || l === '[') ? '[' : '('
    const close = (r === '】' || r === '］' || r === ']') ? ']' : ')'
    const re = new RegExp(`[${escapeReg(l)}]([\\s\\S]*?)[${escapeReg(r)}]`, 'g')
    out = out.replace(re, `${open}$1${close}`)
  }
  return out
}

function removeAllBracketBlocks(s) {
  let out = ''
  const stack = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]

    if (ch === '(' || ch === '[') {
      stack.push(ch)
      continue                 // skip writing any bracketed content
    }
    if (ch === ')' || ch === ']') {
      if (stack.length) {
        const open = stack.pop()
        // optional: validate matching pairs; if mismatched, just treat as closing
      } else {
        // unmatched closing; drop it
      }
      continue                 // also skip the closing char
    }

    if (stack.length === 0) {
      out += ch                // only emit characters when not inside any brackets
    }
  }
  return out
}

function normalizeSpaces(str) {
  // Keep single spaces to preserve token boundaries; add spaces around selected punct.
  return str
      .replace(/\s+/g, ' ')
      .replace(/\s*([()[\]\-:,;~])\s*/g, ' $1 ') // <- hyphen escaped to avoid "range out of order"
      .replace(/\s+/g, ' ')
      .trim()
}

function removeBrackets(fullNorm) {
  // 1) Remove ALL bracketed segments (supports nested () and [])
  let core = removeAllBracketBlocks(fullNorm)

  // 2) Tidy spacing/punctuation left behind
  core = normalizeSpaces(core.replace(/\s*[-–—:|]\s*/g, ' '))

  // If we stripped everything (too aggressive on a rare case), fall back to the original
  if (core.length < 4) core = normalizeSpaces(fullNorm).trim()
  if (core.length < 4) core = fullNorm
  return core
}

function removeAllBracketContent(s) {
  let out = s
  // [] and ()
  out = out.replace(/\[[^\]]*]/g, ' ').replace(/\([^)]*\)/g, ' ')
  return out
}

// Segment for FTS (ja/zh fallback to budoux; else simple whitespace split)
function segmentForFts(s) {
  if (!s) return ''

  const hasHan = /[\p{Script=Han}]/u.test(s)
  const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)
  // const toWords = s => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
// keep decimals like 4.5 or 12.75 (and optionally 4,5 if you want commas)
  const toWords = s => (String(s).toLowerCase().match(/\p{N}+(?:[._]\p{N}+)?|\p{L}+/gu) || [])

  let chunks
  if (hasKana && ja) chunks = ja.parse(s)
  else if (hasHan && (zhHans || zhHant)) chunks = (zhHans || zhHant).parse(s)

  const tokens = chunks?.length
      ? chunks.flatMap(c => toWords(c))
      : toWords(s)

  // dedupe adjacent duplicates, keep order; join with single spaces
  const out = []
  for (const t of tokens) if (t && (out.length === 0 || out[out.length - 1] !== t)) out.push(t)
  return out.join(' ')
}


/**
 * Extract numeric tokens preserving ranges as atomic tokens.
 * Output example: "summer vol 1-3 extra 5" -> ["1-3","5"]
 * Assumes s already passed through: normalizeJPZHNumerals -> normalizeRomanNumeralsWithContext
 */

function extractNumericTokens(s) {
  if (!s) return []
  const tokens = []
  const spans = [] // [start, end) spans for ranges we've already captured

  // number pattern: up to 4 digits, optional one decimal part (e.g., 4.5, 12.75)
  const NUM = String.raw`\d{1,4}(?:\.\d{1,3})?`

  // 1) capture ranges as atomic tokens (no expansion); allow decimals in endpoints
  const rxRange = new RegExp(`(${NUM})\\s*[-–—~〜]\\s*(${NUM})`, 'g')
  for (const m of s.matchAll(rxRange)) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      tokens.push(`${lo}-${hi}`)                 // canonicalized (e.g., "1.5-2")
      spans.push([m.index, m.index + m[0].length])
    }
  }

  // helper to avoid double-counting numbers inside a captured range span
  const inSpan = (i, len) => spans.some(([lo, hi]) => i >= lo && i + len <= hi)

  // 2) grab all numbers (including decimals), skipping those inside a range span
  const rxNum = new RegExp(NUM, 'g')
  for (const m of s.matchAll(rxNum)) {
    if (inSpan(m.index, m[0].length)) continue
    const v = Number(m[0])
    if (Number.isFinite(v)) tokens.push(String(v)) // "04.50" -> "4.5", "001" -> "1"
  }

  // 3) dedupe while preserving order
  const seen = new Set()
  return tokens.filter(t => (seen.has(t) ? false : (seen.add(t), true)))
}

// -------------------- Exports --------------------
module.exports = { normalizeTitle }
