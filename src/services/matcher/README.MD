## Matching File Names with Metadata

This module matches files names to book titles stored in the `gallery` table in  `api_dump.sqlite`.

It creates a table with book titles (`title`, `title_jp`, `torrents[name]` columns) and a full-text search table (fts5).
For each file name, if it finds an exact and unique match in the full title, the book is tagged. Otherwise, it then narrows down a list of candidates and returns the best match by fuzzy search. The book is then tagged with status = 'need-verify'.

**Known issues:**
* We choose to ignore a book's metadata when it does not have either an artist, group, parody, or cosplayer. 

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

### Initialization

* The main process spins out a child process to initialize the search. (`matchPool.workerpool.js)
* It then creates a pool of threads to match file titles in parallel. (`matchWorker.piscina.js)

### Normalize Names

* `normalizer.js`
    * `normalizeTitle(title_raw)`: Main function to normalize a title.
    
* Input
  - `title_raw` (string): the original title.

* What it does (high-level)
  1. **Early exit**: If the title is empty/whitespace, return a scaffold with empty strings and arrays.
  2. **Base normalization**: lowercases, removes file extension, applies Unicode NFKC, converts full-width → half-width, unifies punctuation, trims.
  3. **Noise removal**: strips release/scan blocks like `[]` or `()` at the tail and known noise words.
  4. **Core text**: removes **all bracketed content** and collapses spaces to form `title_core_norm`; also produces an FTS-friendly segmented string `title_core_norm_seg`.
  5. **Number handling**:
      - Converts Japanese/Chinese numerals → Arabic digits.
      - Converts **contextual** Roman numerals → Arabic (only when near structural markers).
      - Extracts all numeric tokens `nums_all`.
  6. **Core (non-numeric) title**: removes digits and recollapses spaces to form `title_core`.

* Output (object)
  - `title_raw`: original input.
  - `title_full_norm`: lightly cleaned version (pre block-removal), good for display/logging.
  - `title_core_norm`: core string with bracketed content removed.
  - `title_core_norm_seg`: FTS-segmented version of `title_core_norm`.
  - `title_core`: core string with all numbers removed.
  - `nums_all`: array of numeric tokens found after numeral normalization.

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
            * We use `nums_all` to filter out candidates: if it is empty, find the gids that have no numeric tokens. Otherwise, find the gids that have all the numeric tokens.
        * Stage C: Return the best fuzzy match on the candidates
            * We choose `fuse.js` to do the fuzzy search. `fuzzysort` is also good but the matches seem less accurate.
            * We give higher scores to matches with 'chinese', 'japanese', or '[]' from `language` column.

### Configuration

* `NORM_VERSION`: bump this up when update the module, triggering a rebuild of the search tables.
* Default values are OK but may not be optimal.
* Tune `FTS_TOPN` and `RERANK_TOPK` for better performance/faster match if needed. Higher values allow more candidates in fuzzy match, lowering the matching speed



