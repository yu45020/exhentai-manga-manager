## Matching File Names with Metadata

This module matches files names to book titles stored in the `gallery` table in  `api_dump.sqlite`.

It creates a table with book titles (`title`, `title_jp`, `torrents[name]` columns) and a full-text search table (fts5).
For each file name, if it finds an exact and unique match in the full title, the book is tagged. Otherwise, it then narrows down a list of candidates and returns the best match by fuzzy search. The book is then tagged with status = 'need-verify'. 

**Known issues:**
* When multiple files share similar names, the fuzzy match may not be accurate. The matcher prefers Japanese and Chinese when deciding the best match. The preference is based on the `factorPreferredLanguage` value to post adjust the fuzzy match score. We don't have a good metric to tune this value. 

* When a file name (after removing all brackets) has multiple exact matches, the matcher returns the first match found but tags the book status as 'need-verify'. No fuzzy search is performed. The downside is that when the book is translated into multiple languages, the match is not adjusted for the preferred language. 

## Experiment
28496 books took 210s 

## Usage
```js
const { createMatcher, initTitleCoreIndex, isInited } = require('./index')
const Database = require('better-sqlite3')
const dbPath = 'api_dump.sqlite'
const dbDataPath = 'database.sqlite'

const dbData = new Database(dbDataPath, { readonly: true, fileMustExist: true })
const rows = dbData.prepare(`
    SELECT id, title
    FROM Mangas
    WHERE tags == '{}'
    ORDER BY length(title) DESC
    limit ${NUM}
`).all()
dbData.close()

// initialize the search tables if needed
const probe = new Database(dbPath, { readonly: false, fileMustExist: true })
const ready = isInited(probe)
if (!ready) {
  initTitleCoreIndex(probe)
}
probe.close()

matcher = createMatcher(dbPath);

(async () => {
// match one title at a time; each row has at most one matched gid 
  for (const row of rows) {
    const res = await matcher.SearchOneTItle(row.title)
  }
// mathch all in parallel
  const results = await matcher.searchAll(rows, { progressEvery: 100, poolSize: 8 })
// get the matadata from the gallery table for the matched rows 
  const metadata = await getMetadata(dbPath, rows)
})().catch((e) => {
  console.error(e)
})
```


## Details of the module

### Normalize Names

* `normalizer.js`
    * `normalizeTitle(title_raw)`: Main function to normalize a title.

### Initialize the search tables

* `fst.js`
    * `buildTitleSearchTables(db)`
        * `db` is the `better-sqlite3` database object.
        * It creates the search table `title_core_index`  and fts table `tci_fts`
        * In the `tci_fts` table, only the `title_core_norm_seg` column is indexed and searched with `bm25`
        * The `title_core_norm_seg` column is a string of tokens separated by spaces. Other columns are included for ease of fuzzy search

### Matching

* `pipeline.js`
    * `searchOne(db,rawTitle)`
        * `db` is the `better-sqlite3` database object, and `rawTitle` is the incoming string to match.
        * Normalize incoming string
        * Stage A: Find an exact match
        * Stage B: If not found, build fst queries to find candidates
            * This step has a huge performance impact on the `bm25` result.
            * When a string is long, using all tokens (e.g., `tok1 AND tok2 ...`) usually gives no match.
            * Instead, we use subsets of tokens to build a list of queries
            * We collect results from each query and stop early if enough candidates are found
        * Stage C: Return the best fuzzy match on the candidates
            * We choose `fuse.js` to do the fuzzy search. `fuzzysort` is also good but the matches seem less accurate.
            * We give higher scores to matches with 'chinese', 'japanese', or '[]' from `language` column. 

### Configuration

* `NORM_VERSION`: bump this up when update the module, triggering a rebuild of the search tables.
* Default values are OK but may not be optimal.
* Tune `FTS_TOPN` and `RERANK_TOPK` for better performance/faster match if needed. Higher values allow more candidates in fuzzy match, lowering the matching speed  