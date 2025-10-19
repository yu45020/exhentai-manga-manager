# Upstream Changes

## Changes
* i18n: openMangaLocation --> revealInFolder:  Reveal in Folder

* At startup, validate cache, if OK, load cache, if not, load books from databases without scanning book existence as this step is costly for large libraries in HDD. Book existence is verified in scan/rebuild/patch or `loadOnStart` is on
* change rebuild pattern in bookDetailDialog:
  * previously, open edit tags (call `editTags`) builds indexes for each category in tags, 
  * new: 
    * rebuild index only when a tag is added/removed/changed, and is delayed to 3s to avoid burst changes
    * changing book tags by batch update or manual search don't trigger the rebuild, the user must scan or restart the program 

## Bug Fixes

### Settings Write Race/Corruption at Startup

- **Issue:** Multiple `save-setting` calls can corrupt `setting.json` (e.g., during startup or when switching languages).
- **Fix:** Coalesce writes; the last write wins but missing settings are preserved. Write to `setting.json.tmp` and then atomically rename.
- **Repro:** On the Settings page, `Trim Title RegExp` is always empty due to concurrent saves.
- **Patch:** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L1409-L1484)

### UTF-8 Encoding & Special Filenames with 7z

- **Issue:** Non-ASCII names and filenames starting with `-` fail the 7z extraction.
- **Fix:** Add `-sccUTF-8` and `--` to 7z arguments; decode output as UTF-8.
- **Repro:** Zip a folder with a Japanese subfolder and a file named `-abc.jpg`. The function fails during the 7z call.
- **Patch:** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/fileLoader/archive.js#L29-L30)

### Duplicate File Handling During Scan

- **Issue:** Duplicates are inconsistently handled between scan and Force Rebuild.
- **Fix:** When a duplicate is found, verify its existence using the file path from the database. If it does not exist, treat it as relocated; otherwise, add as new.
- **Repro:** Copy a file to two folders; scan and Force Rebuild yield different results.
- **Patch:** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L683-L690)

### Minor Guards

- `resultLists` can be undefined [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L217)
- `callback` can be undefined [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L238-L239)
- `collectionList` may not be an array [code1](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L1151-L1152), [code2](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L1198-L1199)

### Misc

- In `getBookInfoFromHentag`, use `category: categoryOption.value[data.category - 1]` (index starts at 0) [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L96-L97) .

## Improvements

### Parallel Scan/Rebuild/Patch with Limits & Abort

- **What:** Concurrency controls for reading archives and writing cover thumbnails; batched DB commits; abortable jobs.
- **Design:**
  - Chunk files into batches; within each batch:
    - Spawn multiple `7z` (`-mmt=1`) processes to load files into RAM.
    - Write cover buffers to disk using a separate queue.
    - Commit DB updates at the end of each batch.
  - Abort controller to cancel in‑flight work.
  - New UI in the settings page: Concurrent read (extract files) and write (cover thumbnails). Defaults are chosen conservatively (read=4 or max CPU, write=2 or max CPU).
  - Check book existence during scan; if a file is missing from disk, assign it the "Missing" category.
- **Experiments:**
  - Force rebuild of a library with 360 files (43.3 GB). App/dbs/cover folder on SSD; library folder on 7200 rpm CMR HDD.

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

  - Higher scan/read values may not improve performance due to bottlenecks in cover writes and DB commits.
  - Scanning 28,521 files (2.68 TB) on HDD: 8r/4w ≈ 2816s, 4r/2w ≈ 2732s

- **Note:** Some antivirus products rescan all touched files (possibly in parallel) after processes exit, causing loud, sustained disk activity. For example, Norton uses `aswidsagent.exe` to scan all files touched by `7z`, and this cannot be disabled. Users may want to whitelist the large library folder during long runs (if possible).
- **Patch:**
  - [Aborter](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L575-L616)
  - [Extract files to RAM](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L515-L516)
  - [`load-book-list`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L620-L621)
  - [`force-gene-book-list`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L789-L790)
  - [`patch-local-metadata`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L911-L912)

### Faster startup via cache 

* **What:** Load app cache upon startup, reducing the time to build `this.bookList` and side panel data 
* **Why:** Loading cache avoids scanning all files on disk on startup; a big plus when the user doesn't update new files frequently 
* **Design:** 
  * Create `meta` table in `database.sqlite` and `metadata.sqlite`. The `meta` table has triggers to track whether the db has inserts/updates/deletes [code](https://github.com/yu45020/exhentai-manga-manager/blob/a84925046cb05e08554b391a4360cbcc3d070684/index.js#L95-L100)
  * Verify whether the db has changed; if not, use cache. [code](https://github.com/yu45020/exhentai-manga-manager/blob/59890a08c3af36f063432950dcac456cfeeae6e9/src/App.vue#L698-L713)
  - `appCache` is mirrored inside `loadCollectionList`, which is called after `scan`, `forced rebuild`, and `patchLocalMeta`. [code](https://github.com/yu45020/exhentai-manga-manager/blob/59890a08c3af36f063432950dcac456cfeeae6e9/src/App.vue#L1311-L1318)
  * Before the program closes, check whether to update the cache. [code](https://github.com/yu45020/exhentai-manga-manager/blob/59890a08c3af36f063432950dcac456cfeeae6e9/index.js#L313-L326)
* **Results:** 
  - The startup time reduces from 3.5s to 1.4s
  - The `appCache` size for 28K rows of files is 7.22MB.
   
### Faster loading book via SQL

- **What:** Replace JS loops with SQL queries in `loadBookListFromDatabase`.
- **Result:** 28,521 files: startup time reduced from 3.61s to 0.39s on my machine.
- **Patch:** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L319-L320)

### Sharded Cover Folder

- **What:** Distribute covers into 256 subfolders using the first two hex digits of the cover hash; file name = `sha256(imageBuffer).webp`.
- **Why:** A single large directory slowed enumeration and cleanup.
- **How:**
  - New path: `cover/<hh><hash>.webp`, where `<hh>` are the first two hex digits of the hash.
  - The database stores the cover hash, so migration is straightforward.
- **Path:**  [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/fileLoader/index.js#L145-L146)

### Faster Library Tree

- **What:** Use binary search to construct the folder tree.
- **How:**
  - Sort and index paths.
  - Calculate and cache the lower and upper bound indices.
  - Perform binary search for a given folder to list all books.
- **Result:** When clicking a folder to display all books under it, the new method is about 2 seconds faster than the previous method when the database has 28K rows.
- **Path:** [`FolderTree.vue`]
  - [build tree](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L235-L236)
  - [list files for a folder](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L418-L419)

### New Category Search Pattern

- **What:** Use `cat:category$` to filter books by category in the search dialog.
- **Why:** The current design uses `category$`, which includes books with titles matching the category name.
- **Patch:**  [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L967-L974)

### New UI Features

#### Internal Browser for Updating Tags

- **What:** Embed a browser to navigate sites and apply tags directly.
- **Why:** The current search dialog only displays titles, and results are often missing.
- **Design:**
  - Open from Book Detail via "Get metadata manually."
  - Built‑in ad blocker; editable URL bar to show the current page; confirm button becomes active on supported URL patterns.
    - ehentai: <https://e-hentai.org/g/{gallery_id}/{gallery_token}/>
    - exhentai: <https://exhentai.org/g/{gallery_id}/{gallery_token}/>
    - nhentai: <https://exhentai.org/g/{gallery_id}>
    - hentag: <https://hentag.com/vault/>
    - panda chaika: paste the `Source metadata` in the URL bar
  - Confirm button: update all manga tags. eh/ex/hentag URLs use the public API; nhentai uses the built-in scraper.
  - Update category/artist/group/cosplayer button:   active when the URL is ex/ehentai;  useful when no exact match.
  - Users need to log in to e-hentai to access exhentai. Login status is persisted.
- **Patch:**  
  - UI: [SearchDialogBrowser.vue](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialogBrowser.vue#L1)
  - Parent node:  [SearchDialog.vue](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L2)

#### Setting: Remove Missing Records

- **What:** A button to remove missing records from the database and unreferenced cover files.
- **Why:** The current design removes missing records during every library scan, which may surprise some users, especially if the library folder is misconfigured.
- **Design:**
  - The button is in Settings → Advanced.
  - When clicked, it verifies the existence of all books in the database, flags missing ones, and caches all thumbnails in the cover folder that are not referenced by any book.
  - A dialog shows the number of missing books, unreferenced covers, a checkbox for vacuuming the database, and a confirm button.
- **Path:**
  - [UI](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L563-L565)
  - [On click](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L1081-L1163)
  - [ipcMain](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L1634-L1793)
  
#### Setting: Library Folder Management

- **What:** Add or remove library folders in the settings page.
- **Why:** The current design allows only a single library root. The new design makes managing multiple library folders easier.
- **Design:**
  - In the settings page, the General tab shows the library folders with a button to manage folders.
  - In the Manage Library tab, users can add or remove folders.
  - New entry in `setting.json`: `'libraries': [path string]`
  - Update `scanLibraryFilesWithExclude` to support multiple library folders.
- **Patch:**
  - [Library folders in the general tab](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L17-L88)
  - [Manage Library Tab](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L155-L230)

#### Side Panel: Folder Tree/Artist/Group/Parody Tabs

- **What:** The folder tree now supports multiple library folders; new tabs provide quick access to artists, groups, and parodies.
- **Why:**
  - The previous folder tree only allowed one library folder, making it inconvenient to manage multiple folders.
  - The main window had tag/artist shortcuts for books, but not for the entire library.
- **Design:**
  - Folder tree:
    - An 'All' node at the top to show all books.
    - Buttons to expand/collapse all nodes.
    - Collapse the top folder node when there is exactly one subfolder and no files at that level.
  - Artist/Group/Parody tabs:
    - Click the tab to show all artists/groups/parodies in the library.
    - Click an item to display books in the main window.
    - Sort items by En/Jp/Zh/Count.
    - Search by En/Jp/Zh.
- **Path:** [`FolderTree.vue`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L1)
  
#### Move File: Move File Dialog

- **What:** A new dialog for choosing a folder to move a file.
- **Why:** The current design makes it difficult to select a folder when there are many subfolders.
- **Design:**
  - Use the system file explorer (`ipcMain.handle('select-folder')`) to pick a folder.
  - The file can be moved to any folder, not limited to library folders.
- **Patch:**
  - [UI](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/MoveFileDialog.vue#L1)
  - [Usage in parent node](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L194-L205)

### UI Tweaks

- Assign missing files the status "Missing" [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L410-L426)
- E‑Hentai‑style category tags, while retaining `tag-failed` and `non-tag` [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/BookCard.vue#L128-L140)
- "Missing" category for missing files. File existence is verified in every scan. [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L406-L407)
- `No Tag Only` [filter](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L54-L55)
- List default tags in Book Detail [Edit Tag](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/BookDetailDialog.vue#L328-L339)
- Mouse back/forward navigation [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L619-L641)
  - `home` UI:
    - a. Back button:
      - If the current page is the first page, reset (same behavior)
      - If not, go to the previous page
    - b. Forward button: go to the next page (if any)
  - `bookdetail` UI:
    - a. Back button: close the book detail UI
    - b. Forward button: view the next book detail (if any)
- Settings page UI alignment after Electron ≥ 30
- Hide comments by default

## Environment

- Windows 11
- App version: 1.6.10
- Upstream commit: 23dc690c (Aug 8, 2025)
