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

const { NORM_VERSION } = require('./config.js')
const path = require('path')

function normalizeTitle(title_raw) {
  if (!title_raw || !String(title_raw).trim()) {
    return {
      title_raw,                 // raw title
      title_full_norm: '',      //  + normalized space and characters
      title_core_norm: '',      //    + remove brackets
      title_core_norm_seg: '', // word tokens for FTS
    }
  }

  // 1) clean + unify
  let s = String(title_raw).toLowerCase()
  s = s.normalize('NFKC')
  s = removeFileExtension(s)
  s = zenkakuToHankaku(s)
  s = unifyPunct(s)
  s = removeEmoji(s)
  s = normalizeBrackets(s)
  s = normalizeSpaces(s)

  const title_full_norm = s

  // 2) build core (strip decorations/entities conservatively; capture trailing parody)
  let title_core_norm = removeBrackets(title_full_norm)

  // 4) segment core for FTS
  const title_core_norm_seg = segmentForFts(title_core_norm)
  return {
    title_raw,
    title_full_norm,
    title_core_norm,
    title_core_norm_seg,
  }
}


// -------------------- Segmentation for FTS --------------------


function segmentForFts(str) {
  if (!str) return ''

  const hasHan = /[\p{Script=Han}]/u.test(str)
  const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(str)
  const toWords = s => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])


  let chunks
  if (hasKana && ja) chunks = ja.parse(str)
  else if (hasHan && (zhHans || zhHant)) chunks = (zhHans || zhHant).parse(str)

  const tokens = chunks?.length
      ? chunks.flatMap(c => toWords(c))
      : toWords(str)

  // dedupe adjacent duplicates, keep order; join with single spaces
  const out = []
  for (const t of tokens) if (t && (out.length === 0 || out[out.length - 1] !== t)) out.push(t)
  return out.join(' ')
}


// -------------------- Tunables --------------------

// full/half-width style brackets we normalize into () or []
const BRACKET_PAIRS = [
  ['「', '」'], ['『', '』'], ['【', '】'], ['〔', '〕'], ['（', '）'], ['《', '》'], ['〈', '〉'],
  ['｛', '｝'], ['{', '}'], ['［', '］'], ['＜', '＞'], ['﴾', '﴿'],
]


// -------------------- Low-level helpers for words and punctuations --------------------
function removeFileExtension(s) {
  return path.parse(s).name
}

function _removeFileExtension(s, extraExts) {
  if (!s) return ''
  let out = String(s).trim()

  // Allow caller to extend the known simple extensions list.
  const simpleExts = new Set([
    // comics & archives
    'cbz', 'cbr', 'cb7', 'zip', 'rar', '7z'
  ])

  if (Array.isArray(extraExts)) {
    for (const e of extraExts) if (e) simpleExts.add(String(e).toLowerCase())
  }

  // 1) .partNN.rar  (e.g., .part01.rar, .part23.rar)
  out = out.replace(/(\.part\d+)\.rar$/i, '')

  // 2) .rNN (RAR volume files like .r00, .r01)
  out = out.replace(/\.r\d{2}$/i, '')

  // 3) split sets: .7z.001 / .zip.001 / .rar.001
  out = out.replace(/\.(7z|zip|rar)\.\d{3}$/i, '')

  // 4) double extensions: .tar.gz / .tar.bz2 / .tar.xz / .tar.zst / .tar.lz / .tar.lz4
  out = out.replace(/\.tar\.(gz|bz2|xz|zst|lz|lz4)$/i, '')
  // also bare .tar
  out = out.replace(/\.tar$/i, '')

  // 5) simple single extensions from the allowlist
  // Build a regex like /\.(jpg|jpeg|png|...|7z)$/i
  const extGroup = Array.from(simpleExts).map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const simpleRe = new RegExp(`\\.(${extGroup})$`, 'i')
  out = out.replace(simpleRe, '')

  return out
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

function removeEmoji(str) {
  try {
    // Removes emojis, pictographs, and skin-tone / modifier sequences
    // Uses Unicode property escapes (Node 14+ / modern browsers)
    str = str.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Presentation}\p{Emoji_Modifier_Base}\p{Emoji}\uFE0F]/gu, '')
  } catch {
    // Fallback for engines without Unicode property escapes
    str = str.replace(
        /(?:[\u203C-\u3299]|[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|[\uFE0F]|[\u200D])/g,
        ''
    )
  }
  return str
}

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

function normalizeSpaces(str) {
  // Keep single spaces to preserve token boundaries; add spaces around selected punct.
  return str
      .replace(/\s+/g, ' ')
      .replace(/\s*([()[\]\-:,;~])\s*/g, ' $1 ') // <- hyphen escaped to avoid "range out of order"
      .replace(/\s+/g, ' ')
      .trim()
}


// -------------------- Core extraction --------------------

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

// --- Helpers ---

// Removes *all* bracketed runs "..." and "[...]" with nesting support
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

// -------------------- Exports --------------------
module.exports = { normalizeTitle, NORM_VERSION }
