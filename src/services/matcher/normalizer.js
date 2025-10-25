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

  // Keep a copy before removing blocks
  const originalNorm = s

  // ---------------- 1) Remove release/scan blocks ([],()) at tail & known noise words ----------------
  const { stripped, removedBlocks } = stripReleaseNoiseBlocks(s)
  s = stripped

  // ---------------- 2) Normalize numerals (kanji → arabic; guarded roman → arabic) ----------------
  const sNumNorm = normalizeJPZHNumerals(s) // kanji → arabic
  // roman → arabic only when near structural markers
  const sNumNormRoman = normalizeRomanNumeralsWithContext(sNumNorm)

  // ---------------- 3) Detect structural volume info & edition bits ----------------
  const volInfo = detectVolumeInfo(sNumNormRoman)
  // edition bits from words in either the stripped or removed blocks
  const edition_bits = extractEditionBits(sNumNormRoman, removedBlocks)

  // ---------------- 5) Compute title_core / title_core_norm / tokens ----------------
  // title_core: remove all digits but keep letters (helps number-insensitive match)
  const title_core = sNumNormRoman.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim()

  // title_full_norm: a lightly cleaned version that callers can display or log
  const title_full_norm = originalNorm

  // title_core_norm: remove inner bracket content (not only trailing) + collapse spaces
  const title_core_norm = removeAllBracketContent(sNumNormRoman).replace(/\s+/g, ' ').trim()

  // segment for FTS (budoux parsers already loaded above)
  const title_core_norm_seg = segmentForFts(title_core_norm)

  // ---------------- 6) Extract numeric tokens for presence gate ----------------
  const nums_all = Array.from(extractInformativeIntegers(originalNorm)) // from original (includes in-title numerals)
  const nums_required = pickRequiredNumerals(nums_all)

  // Final shape (backward compatible + new fields)
  return {
    title_raw,
    title_full_norm,
    title_core_norm,
    title_core_norm_seg,
    title_core,
    vol_num: volInfo.vol_num,
    vol_set: volInfo.vol_set,
    vol_conf: volInfo.vol_conf,
    edition_bits,
    nums_all,
    nums_required
  }
}


// -------------------- Low-level helpers for words and punctuations --------------------
function removeFileExtension(s) {
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
function normalizeRomanNumeralsWithContext(s) {
  return s.replace(/\b(part|pt\.?|season|s)\s*(?=[ivxlcdm]+\b)/gi, m => m) // keep marker
      .replace(/\b(?:(?:part|pt\.?|season|s)\s*)([ivxlcdm]+)\b/gi, (_, rn) => {
        const v = romanToInt(rn)
        return v != null ? String(v) : rn
      })
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

// Detect volume markers & ranges. Returns { vol_num, vol_set, vol_conf }
function detectVolumeInfo(s) {
  // ---------- helpers ----------
  function stripAllTrailingBlocks(str, max = 5) {
    // Remove up to `max` trailing [...] or (...) blocks with optional spaces
    let out = str, i = 0
    while (i < max) {
      const next = out.replace(/\s*(?:\[[^\]]*]|\([^)]*\))\s*$/i, ' ').trim()
      if (next === out) break
      out = next
      i++
    }
    return out
  }

  function isYear(n) { return n >= 1900 && n <= 2100 }

  // ---------- 1) Quick anti-signal: episode/chapter markers ----------
  const reChapter = /\b(?:ch|chap|chapter|#)\s*0*\d+\b|第\s*0*\d+\s*(?:話|节|話|화)\b/i
  if (reChapter.test(s)) return { vol_num: null, vol_set: null, vol_conf: 0 }

  // For relaxed rules below we’ll also use a version with tail blocks removed
  const s2 = stripAllTrailingBlocks(s)

  // ---------- 2) Omnibus ranges with explicit markers (v01-03, vol 01~03) ----------
  // IMPORTANT: we require an explicit volume marker to avoid date ranges like "2016.11 - 2019"
  const reRangeMarked = /\b(?:vol(?:ume)?|v)\s*0*([0-9]{1,4})\s*[-~]\s*0*([0-9]{1,4})\b/i
  {
    const r = reRangeMarked.exec(s2)
    if (r) {
      const a = parseInt(r[1], 10)
      const b = parseInt(r[2], 10)
      if (Number.isFinite(a) && Number.isFinite(b) && a <= b) {
        const set = []
        for (let i = a; i <= b && set.length < 256; i++) set.push(i)
        return { vol_num: null, vol_set: set, vol_conf: 2 }
      }
    }
  }

  // ---------- 3) 上/中/下 (map to 1/2/3) ----------
  {
    let m, set = new Set(), re = /(^|[\s\-\(\[])([上下中])($|[\s\-\)\]])/g
    while ((m = re.exec(s2)) !== null) {
      const ch = m[2]
      if (ch === '上') set.add(1)
      else if (ch === '中') set.add(2)
      else if (ch === '下') set.add(3)
    }
    if (set.size) {
      const arr = Array.from(set)
      return { vol_num: arr.length === 1 ? arr[0] : null, vol_set: arr, vol_conf: 2 }
    }
  }

  // ---------- 4) High markers: Vol/巻/Part/Season/Sx, 第N巻/編/章 (pick rightmost) ----------
  const reHigh = /\b(?:vol(?:ume)?|v|part|pt\.?|season|s)\s*0*([0-9]{1,4})\b|第\s*0*([0-9]{1,4})\s*(?:巻|編|章)\b|([上下中])(?![A-Za-z])/gi
  {
    let hm, best = null
    while ((hm = reHigh.exec(s2)) !== null) {
      let v = null
      if (hm[1]) v = parseInt(hm[1], 10)
      else if (hm[2]) v = parseInt(hm[2], 10)
      else if (hm[3]) v = (hm[3] === '上') ? 1 : (hm[3] === '中' ? 2 : 3)
      if (Number.isFinite(v)) best = { v, idx: hm.index }
    }
    if (best) return { vol_num: best.v, vol_set: null, vol_conf: 2 }
  }

  // ---------- 5) General "end-number" rule (Medium) ----------
  // Idea: the volume is the last numeric token at the end, after removing any number of trailing (...) / [...] blocks.
  // Accept both delimited and glued cases (e.g., "絵本7").
  {
    // 5a) Try on the brackets-stripped tail
    let m = s2.match(/0*([0-9]{1,3})\s*$/)
    if (m) {
      const v = parseInt(m[1], 10)
      if (Number.isFinite(v) && !isYear(v)) {
        return { vol_num: v, vol_set: null, vol_conf: 1 }
      }
    }
    // 5b) If that fails, allow the number immediately before one-or-more trailing blocks in the original
    m = s.match(/0*([0-9]{1,3})\s*(?:\[[^\]]*]|\([^)]*\))+\s*$/)
    if (m) {
      const v = parseInt(m[1], 10)
      if (Number.isFinite(v) && !isYear(v)) {
        return { vol_num: v, vol_set: null, vol_conf: 1 }
      }
    }
  }

  // ---------- No volume ----------
  return { vol_num: null, vol_set: null, vol_conf: 0 }
}



// Edition flags bitmask
// 1<<0 OMNIBUS/合本/全集/総集編, 1<<1 COMPLETE/完全版, 1<<2 REMASTER/新装版, 1<<3 DIGITAL/WEB, 1<<4 UNCENSORED/無修正
function extractEditionBits(s, removedBlocks = []) {
  const text = [s, ...removedBlocks].join(' ').toLowerCase()
  let bits = 0
  if (/\b(omnibus|合本|全集|総集編)\b/.test(text)) bits |= 1 << 0
  if (/\b(complete|完全版)\b/.test(text)) bits |= 1 << 1
  if (/\b(remaster|新装版)\b/.test(text)) bits |= 1 << 2
  if (/\b(digital|web|webrip|web-dl|電子)\b/.test(text)) bits |= 1 << 3
  if (/\b(uncensored|無修正)\b/.test(text)) bits |= 1 << 4
  return bits
}

// Remove ALL bracketed content, not just trailing
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
  const toWords = s => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])


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


// Extract integers and drop junk (years, resolution, isbn-like long ids, build numbers in brackets with scan tags)
function extractInformativeIntegers(s) {
  const out = new Set()
  if (!s) return out
  const text = String(s)
  const re = /\d{1,6}/g
  const junkRes = new Set([360, 480, 540, 720, 1080, 2160])
  const junkYears = (n) => n >= 1900 && n <= 2100

  // If a number is inside a bracket that also has Digital/Web/Kobo/etc., treat as junk
  const bracketJunk = []
  for (const m of text.matchAll(/[\[\(]([^)\]]+)[\)\]]/g)) {
    if (/\b(digital|web|kobo|kindle|dl版|修正版|uncensored|無修正)\b/i.test(m[1])) {
      bracketJunk.push(m[1])
    }
  }

  let match
  while ((match = re.exec(text)) !== null) {
    const raw = match[0]
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) continue
    if (raw.length >= 10) continue // ISBN-ish/too long
    if (junkYears(n)) continue
    if (junkRes.has(n)) continue
    // Skip if this number occurs only inside a bracket-junk block
    const start = match.index
    const insideJunk = bracketJunk.some(b => mIndexOfBlock(text, b, start))
    if (insideJunk) continue
    out.add(n)
  }
  return out
}

function mIndexOfBlock(text, blockContent, pos) {
  // naive containment check helper: is 'pos' within '[blockContent]' or '(blockContent)' ?
  const sq = `[${blockContent}]`
  const rd = `(${blockContent})`
  const idxS = text.indexOf(sq)
  const idxR = text.indexOf(rd)
  const withinS = idxS >= 0 && pos >= idxS && pos <= idxS + sq.length
  const withinR = idxR >= 0 && pos >= idxR && pos <= idxR + rd.length
  return withinS || withinR
}

// Pick at most 2 required numerals (heuristic): prefer >= 2 digits; prefer largest; else none.
function pickRequiredNumerals(nums) {
  if (!nums || !nums.length) return []
  const cand = nums.filter(n => n >= 10) // avoid single-digit which are common/noisy
  cand.sort((a, b) => b - a)
  return cand.slice(0, 2)
}

// -------------------- Exports --------------------
module.exports = { normalizeTitle }
