# Changes from upstream repository (23dc690c Aug 8, 2025)


## Bug fixes

1. Settings writes could race/corrupt at startup
    - **What:** Prevent partial/truncated setting.json when multiple save-setting calls occur close together (e.g., on app startup or language switch).
    - **Why:** Concurrent writes risk leaving a half‑written JSON file if the process exits/crashes mid‑write; settings are lost in the next launch.
   - **How:** 
     - Coalesce writes: the last write wins but missing settings in the later will not override the previous ones
     - Write to setting.json.tmp then atomic rename to setting.json
    - **Reproduce:** 
      - In the Setting page, the `Trim Title RegExp` is always empty.
      - Why: In the `onMounted` function, the variable `trimTitleRegExp` is not in the default setting but is set with a value. It then calls  `save-setting` and `handleLanguageChange` which also have `save-setting` [code]
          (link).
    - **Patch:** [commit 1](link)

2. UTF-8 encoding/decoding & special file names when using 7z
    - **What:** Handle non‑ASCII names and filenames beginning with special characters when invoking 7z.
    - **Why:** Archives containing Japanese names or entries like -abc.jpg caused the first 7z attempt to fail, falling back to `AdmZip`.
    - **How:**
        - Add `-sccUTF-8`  to 7z to force UTF‑8.
        - Insert `--` to mark end of options so leading - in filenames isn’t parsed as a flag.
        - Decode the process output once as UTF‑8.
    - **Reproduce**
        - Add a zip file with Japanese folder name inside; add a file '-abc.jpg' inside.
        - In the console, you will see ``reload ${filepath} use adm-zip`` as the first attempt to use 7z failed.
    - **Patch:** [commit 2](link)

3. Duplicate‑file handling during scan
    - **What:** Treat a duplicated file as relocated if the DB record’s original path is missing; otherwise, treat as a new book.
    - **Why:** Scan ignored duplicates, while Force Rebuild added them—leading to inconsistent results.
    - **How:** When a duplicated file is found,
      - If file path no longer exists on disk → update path (relocation).
      - Else → treat it as a new record.
    - **Reproduce**
      - Copy a file into two folders and scan; the program finds 2 book only one file is added.
      - Click Force Rebuild; now both files are added.
   - **Patch:** [commit 3](link)

4. Small guards, no harm caught errors
   - `resultLists` can be undefined [code](link)
   - `callbcak` can be undefined [code](link)
   - `collectionList` may not be an array [code](link), [code2](link)
    
## New Features
1. Internal browser for updating tags
    - **What:** Embed a browser to navigate sites and apply tags directly 
    - **Why:** The current search dialog only displays titles, and the results are usually missing. 
    - **Design:**
      - Open from Book Detail via Get metadata manually.
      - Built‑in ad blocker; editable URL bar to show current page; confirm button becomes active on support url patterns. 
        - ehentai: https://e-hentai.org/g/{gallery_id}/{gallery_token}/
        - exhentai:https://exhentai.org/g/{gallery_id}/{gallery_token}/
        - nhentai: https://exhentai.org/g/{gallery_id}
        - hentag: https://hentag.com/vault/
        - panda chaika: paste the `Source metadata` in the url bar 
      - Upon confirm, the manga tags are updated. eh/ex/hentag urls use the public api. nhentai uses the built-in scraper; 
      - Partial update button for category/artist/group/cosplayer is active when the url is ex/ehhentai. 
    - **How**
      - Watch `url` in the url bar 
      - Emits **confirm** events from the **SearchDialogBrowser** to **SearchDialog** with `{bookDetail, url}`; 
      - Update tag in **SearchDialog**.
  - **Patch:** [commit 5](link)

2. Parallel scanning/rebuilding/patching with limits & abort
    - **What:** Concurrency controls for reading archives and writing cover thumbnails; batched DB commits; abortable jobs.
    - **Why:** Significantly reduces total time on large libraries
    - **Design:** 
      - hunk files into batches; within each batch:
        - Spawn multiple `7z` (`-mmt=1`) to load files in RAM.
        - Write cover buffers into disk with a separate queue.
        - Commit DB updates at batch end.
      - Abort controller to cancel in‑flight work.
      - New UI in the setting page:  Concurrent read (extract files) and write (cover thumbnails). Defaults chosen conservatively (read=4 or max cpu, write=2 or max cpu).
    - **Experiments**
      - Force rebuild a library of 360 files (43.3 GB). App/dbs/cover folder on SSD; the library folder on 7200 rpm CMR HDD. 
      
       <div style="text-align:center">
        
       | read  | write | time(s)   |
       |-------|-------|-----------|
       | 4     | 2     | 21.77     |
       | 4     | 4     | 19.36     |
       | 6     | 4     | 14.13     |
       | 8     | 2     | 15.90     |
       | **8** | **4** | **11.36** |
       | 8     | 8     | 11.28     |
       | 16    | 4     | 11.10     |
       | 16    | 16    | 11.84     |
       </div>

      - Higher scan/read values may not be better because of bottlenecks on cover writes and DB commits.
      - Scanning 28,521 files (2.68 TB) on HDD: 8r/4w ≈ 2816s, 4r/2w ≈ 2732s
    - **Node:** Some antivirus products rescan all touched files (possibly in parallel) after processes exit, causing loud sustained disk activity. For example, Norton uses `aswidsagent.exe` to scan all files that are touched by `7z` and can't be disabled. Users may want to whitelist the large library folder during long runs (if possible).
   - **Patch:** [commit 7](link)
      - new UI in [SearchDialogBrowser.vue](src/components/SearchDialogBrowser.vue)
      - Update [SearchDialog.vue](src/components/SearchDialog.vue)

3. Faster startup by moving work into SQL
   - **What:** Replace per‑row JS loops with a single SQL query in `loadBookListFromDatabase`.
   - **Why:** Large library folder paid heavy JS overhead upon startup. 
   - **How:** use SQL query to update and return book list.
   - **Patch:** [commit 8](link)
   - **Test:** 28,521 files: startup time reduce 3.61s -> 0.39s on my machine.


4. Shard cover folder
   - **What:** Distribute covers into 256 subfolders using the first two hex digits of the cover hash; file name = `sha256(imageBuffer).webp`.
   - **Why:** A single giant directory slowed enumeration and cleanup. 
   - **How:** 
     - New path: `cover/<hh><hash>.webp` where `<hh>` are the first two hex digits of the hash.
     - DB stores the cover hash, so migration is straightforward.

5. UI Tweaks
   - E‑Hentai‑style category tags while retaining `tag-failed` and `non-tag`.[commit 9](link)
   - `No Tag Only` filter. [commit 10](link)
   - Default tag categories surfaced in Book Detail (Edit Tag) . [commit 11](link)
   - Mouse back/forward navigation: [commit 12](link)
     - `home` UI, 
       - a. back button:
         - if the current page is the first page, reset (same behavior)
         - if not, go to the previous page
       - b. forward button: go to the next page (if any)
     - `bookdetail` UI, 
       - a. back button: close the book detail UI
       - b. forward button: see the next book detail (if any)
   - Settings page UI alignment after Electron ≥ 30
    - **Patch:** [commit 4](link)

## Environment
* Win 11 
* App version: 1.6.10