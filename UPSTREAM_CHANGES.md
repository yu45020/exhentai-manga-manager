# Upstream Changes (Last updated: Oct-20-2025)

* Known issues:
  * Fuzzy matching fails when titles don’t exactly match and include series numbers.

## Bug Fixes

### Settings Write Race/Corruption at Startup

* **Issue:** Concurrent `save-setting` calls can corrupt `setting.json` (e.g., during startup or when switching languages).
* **Fix:** Coalesce writes; the last write wins but missing settings are preserved. Write to `setting.json.tmp` and then atomically rename.
* **Repro:** On the Settings page, `Trim Title RegExp` is always empty due to concurrent saves.
* **Patch:** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L1409-L1484)

### UTF-8 Encoding & Special Filenames with 7z

* **Issue:** Archives with non-ASCII paths or filenames starting with `-` failed extraction.
* **Fix:** Add `-sccUTF-8` and `--` to 7z arguments; decode output as UTF-8.
* **Repro:** Zip a folder with a Japanese subfolder and a file named `-abc.jpg`. The function fails during the 7z call.
* **Patch:** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/fileLoader/archive.js#L29-L30)

### Duplicate File Handling During Scan

* **Issue:** Duplicates behaved differently between Scan and Force Rebuild.
* **Fix:** On duplicate detection, verify the original path from DB. If the file is gone, treat as relocated; otherwise add as new.
* **Repro:** Copy a file to two folders; scan and Force Rebuild yield different results.
* **Patch:** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L683-L690)

### Minor Guards

* `resultLists` can be undefined [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L217)
* `callback` can be undefined [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L238-L239)
* `collectionList` may not be an array [code1](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L1151-L1152), [code2](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L1198-L1199)

### Misc

* In `getBookInfoFromHentag`, use `category: categoryOption.value[data.category - 1]` (index starts at 0) [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L96-L97) .

## Breaking Changes

* Metadata scrapers:  Only E-Hentai / ExHentai are supported for image-hash lookups (unique results per hash).
* Sqlite3: Pinned to 5.1.6 to use prebuilt binaries (5.1.7 requires building from source at the time of writing).
* i18n: openMangaLocation --> revealInFolder (“Reveal in Folder”)
* Startup: File existence is no longer verified at startup; users must Scan/Rebuild/Patch to verify
* Tag index: Rebuilt only when tags are edited in Book Detail. Previously, opening the edit dialog rebuilt per category. Batch update / delete / manual search no longer trigger rebuilds. Only rebuild tag index when there are new manual changes in bookDetailDialog.

## Improvements

### Parallel Scan/Rebuild/Patch with Limits & Abort

* **What:** Concurrency controls for reading archives and writing cover thumbnails; batched DB commits; abortable jobs.
* **Design:**
  * Chunk files into batches; within each batch:
    * Spawn multiple `7z` (`-mmt=1`) processes to load files into RAM.
    * Write cover buffers to disk using a separate queue.
    * Commit DB updates at the end of each batch.
  * Abort controller to cancel in‑flight work.
  * New UI in the settings page: Concurrent read (extract files) and write (cover thumbnails). Defaults are chosen conservatively (read=4 or max CPU, write=2 or max CPU).
  * Check book existence during scan; if a file is missing from disk, assign it the "Missing" category.
* **Experiments:**
  * Force rebuild of a library with 360 files (43.3 GB). App/dbs/cover folder on SSD; library folder on 7200 rpm CMR HDD.

    <div style="text-align:center; margin-left:25%">

    | read  | write | time(s)   |
    | ----- | ----- | --------- |
    | 4     | 2     | 21.77     |
    | 4     | 4     | 19.36     |
    | 6     | 4     | 14.13     |
    | 8     | 2     | 15.90     |
    | **8** | **4** | **11.36** |
    | 8     | 8     | 11.28     |
    | 16    | 4     | 11.10     |
    | 16    | 16    | 11.84     |

     </div>

  * Higher scan/read values may not improve performance due to bottlenecks in cover writes and DB commits.
  * Scanning 28,521 files (2.68 TB) on HDD: 8r/4w ≈ 2816s, 4r/2w ≈ 2732s

* **Note:** Some antivirus products rescan all touched files (possibly in parallel) after processes exit, causing loud, sustained disk activity. For example, Norton uses `aswidsagent.exe` to scan all files touched by `7z`, and this cannot be disabled. Users may want to whitelist the large library folder during long runs (if possible).
* **Patch:**
  * [Aborter](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L575-L616)
  * [Extract files to RAM](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L515-L516)
  * [`load-book-list`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L620-L621)
  * [`force-gene-book-list`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L789-L790)
  * [`patch-local-metadata`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L911-L912)

### Faster startup via cache

* **What:** Load an app cache at startup, reducing the time to build `this.bookList` and side panel data
* **Why:** Skips disk scans when the library hasn’t changed, improving startup speed.
* **Design:**
  * Create `meta` table in `database.sqlite` and `metadata.sqlite`. The `meta` table has triggers to track whether the db has inserts/updates/deletes [code](https://github.com/yu45020/exhentai-manga-manager/blob/a84925046cb05e08554b391a4360cbcc3d070684/index.js#L95-L100)
  * Verify whether the db has changed; if not, use cache. [code](https://github.com/yu45020/exhentai-manga-manager/blob/59890a08c3af36f063432950dcac456cfeeae6e9/src/App.vue#L698-L713)
  * `appCache` is mirrored inside `loadCollectionList`, which is called after `scan`, `forced rebuild`, and `patchLocalMeta`. [code](https://github.com/yu45020/exhentai-manga-manager/blob/59890a08c3af36f063432950dcac456cfeeae6e9/src/App.vue#L1311-L1318)
  * Before the program closes, check whether to update the cache. [code](https://github.com/yu45020/exhentai-manga-manager/blob/59890a08c3af36f063432950dcac456cfeeae6e9/index.js#L313-L326)
* **Results:**
  * The startup time reduces from 3.5s to 1.4s
  * The `appCache` size for 28K rows of files is 7.22MB.

### Faster loading book via SQL

* **What:** Replace JS loops with SQL queries in `loadBookListFromDatabase`.
* **Result:** 28,521 files: startup time reduced from 3.61s to 0.39s on my machine.
* **Patch:** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L319-L320)

### Sharded Cover Folder

* **What:** Distribute covers into 256 subfolders using the first two hex digits of the cover hash; file name = `sha256(imageBuffer).webp`.
* **Why:** A single large directory slowed enumeration and cleanup.
* **How:**
  * New path: `cover/<hh><hash>.webp`, where `<hh>` are the first two hex digits of the hash.
  * The database stores the cover hash, so migration is straightforward.
* **Path:**  [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/fileLoader/index.js#L145-L146)

### Faster Library Tree

* **What:** Use binary search to construct the folder tree.
* **How:**
  * Sort and index paths.
  * Calculate and cache the lower and upper bound indices.
  * Perform binary search for a given folder to list all books.
* **Result:** When clicking a folder to display all books under it, the new method is about 2 seconds faster than the previous method when the database has 28K rows.
* **Path:** [`FolderTree.vue`]
  * [build tree](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L235-L236)
  * [list files for a folder](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L418-L419)

### New UI Features

#### Internal Browser for Updating Tags

* **What:** Embed a browser to navigate sites and apply tags directly.
* **Why:** The current search dialog only displays titles, and results are often missing.
* **Design:**
  * Open from Book Detail via "Get metadata manually."
  * Built‑in ad blocker; editable URL bar to show the current page; confirm button becomes active on supported URL patterns.
    * ehentai: <https://e-hentai.org/g/{gallery_id}/{gallery_token}/>
    * exhentai: <https://exhentai.org/g/{gallery_id}/{gallery_token}/>
    * nhentai: <https://exhentai.org/g/{gallery_id}>
    * hentag: <https://hentag.com/vault/>
    * panda chaika: paste the `Source metadata` in the URL bar
  * Confirm button: update all manga tags. eh/ex/hentag URLs use the public API; nhentai uses the built-in scraper.
  * Update category/artist/group/cosplayer button:   active when the URL is ex/ehentai;  useful when no exact match.
  * Users need to log in to e-hentai to access exhentai. Login status is persisted.
* **Patch:**  
  * UI: [SearchDialogBrowser.vue](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialogBrowser.vue#L1)
  * Parent node:  [SearchDialog.vue](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L2)

[img](https://private-user-images.githubusercontent.com/28139045/495008669-04ecb154-2b66-4134-ba6a-96851bae7156.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYxMTAsIm5iZiI6MTc2MTEwNTgxMCwicGF0aCI6Ii8yODEzOTA0NS80OTUwMDg2NjktMDRlY2IxNTQtMmI2Ni00MTM0LWJhNmEtOTY4NTFiYWU3MTU2LnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDMzMFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTgyMDdhOGFhZTk0YzZkNTEyNmI5NDhiNjc2NzIxNThhMTU2MTM3ZWE1YzRmMmM4ZmRiZGU3N2M0YjU4Y2RjN2QmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.4URlP_pJHCF76TqwEsZzc-29lThow7nQx01U_93SFH4)

### Redesigned Search Bar

* **What:** Fuzzy suggestions + boolean queries.
* **Design:**
  * Inline search tips
  * `fuse` for tag indexes and suggestions
  * `liqe` + custom parser for boolean multi-conditions
  * See [Searcher document](https://github.com/yu45020/exhentai-manga-manager/blob/728052ba4b7e538eb301bd0d595a69dd7e9bc388/src/composables/makeFuseSearch.md#L1)

[img](https://private-user-images.githubusercontent.com/28139045/503414618-4673f9c8-6a2a-4092-bb68-ed2a9e26357e.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYzNjEsIm5iZiI6MTc2MTEwNjA2MSwicGF0aCI6Ii8yODEzOTA0NS81MDM0MTQ2MTgtNDY3M2Y5YzgtNmEyYS00MDkyLWJiNjgtZWQyYTllMjYzNTdlLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDc0MVomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTE3YTAyOGJkMWJmM2JlZjM5ZWI2ZDVjZWIyYzQ2ZTkyMzU2ZmIxZWQ4NDdkMmNlZTE0YmQyYjE0MWYxMzJiMjYmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.08oCxjsM6LRuls4wJap-znmA15b-cajwCQ1ZJCd8WtQ)

[img](https://private-user-images.githubusercontent.com/28139045/503434302-97305792-685f-4c87-ab8b-c5bd00a8c6c1.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYzNjEsIm5iZiI6MTc2MTEwNjA2MSwicGF0aCI6Ii8yODEzOTA0NS81MDM0MzQzMDItOTczMDU3OTItNjg1Zi00Yzg3LWFiOGItYzViZDAwYThjNmMxLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDc0MVomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPWIxZWQ1YWY0OWI1Y2VmZDFhMjRhZGZjMzQxMWUyNzY2ODBiMjk1M2VmOGY2MDBjM2IwZGQ0ZWY0NzFlMDExNzQmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.JKvvTc2t5q2V3WITCvFc_nFO9cndkl52lGq5xJL58Oo)

### Batch Metadata Update

* **What:** A unify panel for batch metadata update & verification
* **Design:**
  * Methods:
    * Image hash → Ex/ExHentai
    * Exact/fuzzy match via `api_dump.sqlite`
    * EhViewer local folder info → match `api_dump.sqlite` or Ex public API
  * Quick actions dropdown in main window
  * A [verification page](https://github.com/yu45020/exhentai-manga-manager/blob/728052ba4b7e538eb301bd0d595a69dd7e9bc388/src/components/VerifyFuzzyMatch.vue#L1) to manually confirm fuzzy matches
  * New status `need-verify`  when updated from  `api_dump.sqlite`.

* **Fuzzy Match Flow:**
  * Initialize `api_dump.sqlite` with a table of filenames + FTS virtual table (takes ~1 min).
  * Try exact matches on normalized filenames.
  * If >1 exact match, set `need-verify`
  * Otherwise, rank candidates via  `bm25` and fuzzy match; still set `need-verify`
  * A dedicated process manages a worker pool for parallel matching.
  
* **Results:**
  * 28496 books fuzzy-matched in ~210 s.
* **Patch:**
  * `./src/main/matcher`
  * [Detailed implementation](https://github.com/yu45020/exhentai-manga-manager/blob/728052ba4b7e538eb301bd0d595a69dd7e9bc388/src/main/matcher/README.MD#L1)

[img](https://private-user-images.githubusercontent.com/28139045/503412146-a580b0a1-bf3f-4e82-ae93-297949dfdf17.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYzNjEsIm5iZiI6MTc2MTEwNjA2MSwicGF0aCI6Ii8yODEzOTA0NS81MDM0MTIxNDYtYTU4MGIwYTEtYmYzZi00ZTgyLWFlOTMtMjk3OTQ5ZGZkZjE3LnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDc0MVomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTAwZDlmNmRjMmRjNmM5ZWU2ZmVlNDVlZjQzNGRlZjVjYWM1ZGVmMWUzYTVkN2ZhNmZmOWE5MTU3ZWM3MzcwZWEmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.l1jSizvB3e7jTMDea7Feaouv2tgNfagtS6FOZAM7DJU)

[img](https://private-user-images.githubusercontent.com/28139045/503412147-c6aee565-31a8-4836-b048-60b28b5def11.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYzNjEsIm5iZiI6MTc2MTEwNjA2MSwicGF0aCI6Ii8yODEzOTA0NS81MDM0MTIxNDctYzZhZWU1NjUtMzFhOC00ODM2LWIwNDgtNjBiMjhiNWRlZjExLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDc0MVomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTM1NDE4OTFkYjIwMTgwZGU2YTc1YzkwNzAxNWQyNGRhZGZhMDAwM2YzMTdiZDU1NTRlNzA4ZmFhNGNiMDMyOGQmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.PzsN_rmv4w_5xfZ0yp--LuPhRj3d2Q6suyouvvFiKE4)

[img](https://private-user-images.githubusercontent.com/28139045/503416534-56a44286-9a5f-4bcd-9919-37072795fe6b.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYzNjEsIm5iZiI6MTc2MTEwNjA2MSwicGF0aCI6Ii8yODEzOTA0NS81MDM0MTY1MzQtNTZhNDQyODYtOWE1Zi00YmNkLTk5MTktMzcwNzI3OTVmZTZiLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDc0MVomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTA2MmRhZWVmZjU1Y2U1YTk2ZmRhMmIxN2I3ZGE0MGY4NjQ4Zjk3OWE4ZTMxOTM2MTRhYzg0OWZhODlkZTZmODkmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.y4npuavp2YKfTzbczoeA0HG5drqGNgNyA_yVcUck0Fs)

### Tag Translation

* **What:** Unified, on-demand tag translation.
* **Why:**
  * The translation dataset is category-aware (same term differs by category). Previous flattening `{term: {name, intro}}` caused incorrect translations.
  
* **Design:**
  * Load or download the translation file in the main process; parse without flattening. [code](https://github.com/yu45020/exhentai-manga-manager/blob/728052ba4b7e538eb301bd0d595a69dd7e9bc388/src/main/translation/translationLoader.js#L20)
  * Add a `translate` [function](https://github.com/yu45020/exhentai-manga-manager/blob/728052ba4b7e538eb301bd0d595a69dd7e9bc388/src/pinia.js#L374) in `pinia.js` to translate tags automatically when translation is enabled.
  * For lookups, use [layered search](https://github.com/yu45020/exhentai-manga-manager/blob/728052ba4b7e538eb301bd0d595a69dd7e9bc388/src/main/translation/translationResolver.js#L73) with caching: if a tag’s category is known, search that category first; otherwise search other categories.
* **Patch:** See loader, resolver, and integration in `src/main/translation`

#### Setting: Remove Missing Records

* **What:** A button to remove missing records from the database and unreferenced cover files.
* **Why:** The current design removes missing records during every library scan, which may surprise some users, especially if the library folder is misconfigured.
* **Design:**
  * The button is in Settings → Advanced.
  * When clicked, it verifies the existence of all books in the database, flags missing ones, and caches all thumbnails in the cover folder that are not referenced by any book.
  * A dialog shows the number of missing books, unreferenced covers, a checkbox for vacuuming the database, and a confirm button.
* **Path:**
  * [UI](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L563-L565)
  * [On click](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L1081-L1163)
  * [ipcMain](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L1634-L1793)
  
  [img](https://private-user-images.githubusercontent.com/28139045/495008713-afb737c1-ade1-4a2b-9e8e-f91ded7b4990.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYxMTAsIm5iZiI6MTc2MTEwNTgxMCwicGF0aCI6Ii8yODEzOTA0NS80OTUwMDg3MTMtYWZiNzM3YzEtYWRlMS00YTJiLTllOGUtZjkxZGVkN2I0OTkwLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDMzMFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTIxNTU5NjMyMDIxNTkwOTFjYTEyNzlkNTc3ZmI5ZTkwNWRiMTI2NmEwMGQ5NzNhZTllZmUyZWI2NGZhMTJmZjYmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.Y6MqMKGGuWy5HTI6ogMNoOJbjHYF_sdXy9e7qIqAyYM)

#### Setting: Library Folder Management

* **What:** Add or remove library folders in the settings page.
* **Why:** The current design allows only a single library root. The new design makes managing multiple library folders easier.
* **Design:**
  * In the settings page, the General tab shows the library folders with a button to manage folders.
  * In the Manage Library tab, users can add or remove folders.
  * New entry in `setting.json`: `'libraries': [path string]`
  * Update `scanLibraryFilesWithExclude` to support multiple library folders.
* **Patch:**
  * [Library folders in the general tab](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L17-L88)
  * [Manage Library Tab](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L155-L230)

[img](https://private-user-images.githubusercontent.com/28139045/495009177-f2ddb640-ba2b-4ae5-99b9-7f8473a95722.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYxMTAsIm5iZiI6MTc2MTEwNTgxMCwicGF0aCI6Ii8yODEzOTA0NS80OTUwMDkxNzctZjJkZGI2NDAtYmEyYi00YWU1LTk5YjktN2Y4NDczYTk1NzIyLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDMzMFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTUwMzgwMGMxOGIxZDRiOGI2ZTFiNDNmODRmODNjNTI3NGM5OWM3YzY0YmIxNDY1OGE3ZmI3YWRmOWUxMTcyMTkmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.9eYqQVfGH4HfgIP_JM5RHB1Ml7OBf4Ny18fDcagOslY)

#### Side Panel: Folder Tree/Artist/Group/Parody Tabs

* **What:** The folder tree now supports multiple library folders; new tabs provide quick access to artists, groups, and parodies.
* **Why:**
  * The previous folder tree only allowed one library folder, making it inconvenient to manage multiple folders.
  * The main window had tag/artist shortcuts for books, but not for the entire library.
* **Design:**
  * Folder tree:
    * An 'All' node at the top to show all books.
    * Buttons to expand/collapse all nodes.
    * Collapse the top folder node when there is exactly one subfolder and no files at that level.
  * Artist/Group/Parody tabs:
    * Click the tab to show all artists/groups/parodies in the library.
    * Click an item to display books in the main window.
    * Sort items by En/Jp/Zh/Count.
    * Search by En/Jp/Zh.
* **Path:** [`FolderTree.vue`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L1)
  
  [img](https://private-user-images.githubusercontent.com/28139045/495008782-683634c5-dfdd-4be1-9b9d-b826387aaa02.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NjExMDYxMTAsIm5iZiI6MTc2MTEwNTgxMCwicGF0aCI6Ii8yODEzOTA0NS80OTUwMDg3ODItNjgzNjM0YzUtZGZkZC00YmUxLTliOWQtYjgyNjM4N2FhYTAyLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNTEwMjIlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjUxMDIyVDA0MDMzMFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTQ1ZWJlNTI4MzdmMzc3ODg5YmI1YWQ2MGYzOTU5NmYyMzg3ODY5M2RiMjYzZTIzZjMxNjUxOGVlYTMyMmIyZTkmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.Ao1P1IwotwY7Td7oXuXG1c_RHqPWiUPGA8BTpqF7fQs)

#### Move File: Move File Dialog

* **What:** A new dialog for choosing a folder to move a file.
* **Why:** The current design makes it difficult to select a folder when there are many subfolders.
* **Design:**
  * Use the system file explorer (`ipcMain.handle('select-folder')`) to pick a folder.
  * The file can be moved to any folder, not limited to library folders.
* **Patch:**
  * [UI](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/MoveFileDialog.vue#L1)
  * [Usage in parent node](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L194-L205)

### UI Tweaks

* Assign missing files the status "Missing" [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L410-L426)
* E‑Hentai‑style category tags, while retaining `tag-failed` and `non-tag` [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/BookCard.vue#L128-L140)
* "Missing" category for missing files. File existence is verified in every scan. [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L406-L407)
* `No Tag Only` [filter](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L54-L55)
* List default tags in Book Detail [Edit Tag](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/BookDetailDialog.vue#L328-L339)
* Mouse back/forward navigation [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L619-L641)
  * `home` UI:
    * a. Back button:
      * If the current page is the first page, reset (same behavior)
      * If not, go to the previous page
    * b. Forward button: go to the next page (if any)
  * `bookdetail` UI:
    * a. Back button: close the book detail UI
    * b. Forward button: view the next book detail (if any)
* Settings page UI alignment after Electron ≥ 30
* Hide comments by default

## Environment

* Windows 11
* App version: 1.6.10
* Upstream commit: 23dc690c (Aug 8, 2025)
