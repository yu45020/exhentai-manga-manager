# Upstream Changes

## Bug Fixes

### Settings Write Race/Corruption at Startup

- **Issue:** Multiple `save-setting` calls can corrupt `setting.json` (e.g., during startup or when switching languages).
- **Fix:** Coalesce writes; the last write wins but missing settings are preserved. Write to `setting.json.tmp` and then atomically rename.
- **Repro:** On the Settings page, `Trim Title RegExp` is always empty due to concurrent saves.
- **Patch:** [commit 1](link)

### UTF-8 Encoding & Special Filenames with 7z

- **Issue:** Non-ASCII names and filenames starting with `-` fail the 7z extraction.
- **Fix:** Add `-sccUTF-8` and `--` to 7z arguments; decode output as UTF-8.
- **Repro:** Zip a folder with a Japanese subfolder and a file named `-abc.jpg`. The function fails during the 7z call.
- **Patch:** [commit 2](link)

### Duplicate File Handling During Scan

- **Issue:** Duplicates are inconsistently handled between scan and Force Rebuild.
- **Fix:** When a duplicate is found, verify its existence using the file path from the database. If it does not exist, treat it as relocated; otherwise, add as new.
- **Repro:** Copy a file to two folders; scan and Force Rebuild yield different results.
- **Patch:** [commit 3](link)

### Minor Guards

- `resultLists` can be undefined [code](link)
- `callback` can be undefined [code](link)
- `collectionList` may not be an array [code](link), [code2](link)

### Misc

- In `getBookInfoFromHentag`, use `category: categoryOption.value[data.category-1]` (index starts at 0).

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
- **Patch:** [commit 7](link)
  - UI: [SearchDialogBrowser.vue](src/components/SearchDialogBrowser.vue)
  - Update: [SearchDialog.vue](src/components/SearchDialog.vue)

### Faster Startup via SQL

- **What:** Replace JS loops with SQL queries in `loadBookListFromDatabase`.
- **Result:** 28,521 files: startup time reduced from 3.61s to 0.39s on my machine.
- **Patch:** [commit 8](link)

## Sharded Cover Folder

- **What:** Distribute covers into 256 subfolders using the first two hex digits of the cover hash; file name = `sha256(imageBuffer).webp`.
- **Why:** A single large directory slowed enumeration and cleanup.
- **How:**
  - New path: `cover/<hh><hash>.webp`, where `<hh>` are the first two hex digits of the hash.
  - The database stores the cover hash, so migration is straightforward.

## Faster Library Tree

- **What:** Use binary search to construct the folder tree.
- **How:**
  - Sort and index paths.
  - Calculate and cache the lower and upper bound indices.
  - Perform binary search for a given folder to list all books.
- **Result:** When clicking a folder to display all books under it, the new method is about 2 seconds faster than the previous method when the database has 28K rows.
- **Path:** `FolderTree.vue`

## New Category Search Pattern

- **What:** Use `cat:category$` to filter books by category in the search dialog.
- **Why:** The current design uses `category$`, which includes books with titles matching the category name.
- **Patch:**  [commit 13](link)

## New UI Features

### Internal Browser for Updating Tags

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
- **Patch:** [commit 5](link)

### Setting: Remove Missing Records

- **What:** A button to remove missing records from the database and unreferenced cover files.
- **Why:** The current design removes missing records during every library scan, which may surprise some users, especially if the library folder is misconfigured.
- **Design:**
  - The button is in Settings → Advanced.
  - When clicked, it verifies the existence of all books in the database, flags missing ones, and caches all thumbnails in the cover folder that are not referenced by any book.
  - A dialog shows the number of missing books, unreferenced covers, a checkbox for vacuuming the database, and a confirm button.

### Setting: Library Folder Management

- **What:** Add or remove library folders in the settings page.
- **Why:** The current design allows only a single library root. The new design makes managing multiple library folders easier.
- **Design:**
  - In the settings page, the General tab shows the library folders with a button to manage folders.
  - In the Manage Library tab, users can add or remove folders.
  - New entry in `setting.json`: `'libraries': [path string]`
  - Update `scanLibraryFilesWithExclude` to support multiple library folders.
- **Patch:**
  - `LibraryFolderDialog.vue` [commit 15](link)

### Side Panel: Folder Tree/Artist/Group/Parody Tabs

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
- **Path:** `FolderTree.vue`
  
### Move File: Move File Dialog

- **What:** A new dialog for choosing a folder to move a file.
- **Why:** The current design makes it difficult to select a folder when there are many subfolders.
- **Design:**
  - Use the system file explorer (`ipcMain.handle('select-folder')`) to pick a folder.
  - The file can be moved to any folder, not limited to library folders.
- **Patch:** `MoveFileDialog.vue` [commit 14](link)

## UI Tweaks

- Assign missing files the status "Missing" [commit 6](link)
- E‑Hentai‑style category tags, while retaining `tag-failed` and `non-tag` [commit 9](link)
- "Missing" category for missing files. File existence is verified in every scan.
- `No Tag Only` filter [commit 10](link)
- List default tags in Book Detail (Edit Tag) [commit 11](link)
- Mouse back/forward navigation [commit 12](link):
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
