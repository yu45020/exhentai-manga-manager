const os = require('os')
const NORM_VERSION = '1.0.0'


/** ------------------------ Pipeline Config  ------------------------*/
const DEFAULTS = {
  FTS_TOPN: 30,          // take a generous slice for accuracy
  RERANK_TOPK: 30,       // how many to pass to fuzzy match
  TABLE_TCI: 'title_core_index',
  TABLE_FTS: 'tci_fts',   // FTS5 virtual table linked to TCI via rowid=id
  COL_ID: 'gid',
  COL_RAW: 'title_raw',
  COL_FULL: 'title_full_norm',
  COL_CORE: 'title_core_norm',
  COL_LANG: 'language',
  LIMIT_FULL: 5, // stage A: exact match using title_full_norm
  LIMIT_CORE: 5, // stage A: exact match using title_core_norm
}
const DEFAULT_FUSE_OPTS = {
  includeScore: false,
  shouldSort: true,
  ignoreLocation: true,            // title strings can be long; don't penalize position
  threshold: 0.6,                  // 0.0 strict … 1.0 very fuzzy, .6 is default and seems ok; 0.4 is too strict
  distance: 100,                   // how far matches can be from the expected location
  factorPreferredLanguage: 0.7, // lower is better, multiply search score by this factor to boost jp/zh
  // weight core higher than full
  keys: [
    { name: DEFAULTS.COL_CORE, weight: 0.7 },
    { name: DEFAULTS.COL_FULL, weight: 0.6 },
  ],
}
const DECISION = {
  exact: 'exact',
  ambiguous: 'ambiguous',
  none: 'none',
  review: 'need-verify',
}
const REASONS = {
  exact_full: 'exact_full',
  exact_full_collision: 'exact_full_collision',
  exact_core: 'exact_core',
  exact_core_collision: 'exact_core_collision',
  no_exact: 'no_exact',
  no_candidates: 'no_candidates',
  fuzzy_rank: 'fuzzy_rank',
  empty_query: 'empty_query',
  fall_back_bm25: 'fall_back_bm25',
}



/** ------------------------ Parallel Search ------------------------*/

const POOL = Math.max(1, Number(Math.min(os.cpus().length, 8)))
const BATCH = 1000

module.exports = { NORM_VERSION, DEFAULTS, DEFAULT_FUSE_OPTS, DECISION, REASONS, BATCH, POOL }