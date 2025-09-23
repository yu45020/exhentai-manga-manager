## Add mouse backward/forward buttons

1. In the 'home' UI
   a. press mouse back button:
    - if the current page is the first page, reset (same behavior)
    - if not, go to the previous page
      b. press mouse forward button:
    - if the current page is not the last page, go to the next page
2. In the 'bookdetail' UI
   a. press mouse back button:
    - close the bookdetail UI
      b. press mouse forward button:
    - see the next book detail (if any)

Related codes:
```js
// App.vue
<script>
  methods:{
  resolveKye(event){
}
}
</script>
```

## Bugs/Features

1. Silent errors

```vue

<script>
  <!--
  searchdialog.vue-->
  const getBooksMetadata = async(...)
  {
    <!-- resultList[0] can be undefined. The current uses this error to add 'tag-failed' tag-->
    if (!resultList[0]) {
      book.status = 'tag-failed'
      await saveBook(book)
    } else {
      resolveSearchResult(book.id, resultList[0].url, resultList[0].type)
    }
    printMessage('success', t('c.getMetadataComplete'))
    // callbacks can be undefined
    + callback?.()
    - callback()
  }
</script>
```

2. Duplicated & Relocated in Scanning

check whether prev exists and whether the file/folder exists. If the file/folder doesn't exist, it is duplicated.
Create a new entry for it. This behavior is consistent with the 'Force Rebuild' that scans and creates new entries for
files in the library.

```js
// index.js 
ipcMain.handle('load-book-list', async (event, scan) => {
  const existingManga = await findSameFile(filepath, type, Manga)
  if (existingManga) {
    const prev = byId.get(existingManga.id) || null
    if (prev) {
      // file is relocated if the filepath doesn't exist
      const exist = await pathExists(prev.filepath)
      if (!exist) {
        prev.exist = true
        const newCoverPath = makeShardedPath(COVER_PATH, path.basename(prev.coverPath))
        prev.coverPath = newCoverPath
        prev.filepath = filepath
        byFilepath.set(filepath, prev)
        await dbLimit(() =>
          Manga.update({ filepath: filepath, coverPath: newCoverPath }, { where: { id: existingManga.id } })
        )
        return
      }
    } //else: duplicated file, continue to add it as a new entry
  }
}
```

3. fix UTF-8 encoding/decoding when using 7z

Always add "--" to avoid errors caused by file names starting with special characters such as  '-' and '@'

```js
// fileLoader/archive.js
const solveBookTypeArchive = async()
{
  // manually create folder to reduce disk active time when run in parallel
  await fs.promises.mkdir(tempFolder, { recursive: true })

  // Make 'l' output UTF-8 so Japanese paths are correct
  const output = await spawnPromise(_7z, ['l', '-slt', '-sccUTF-8', '-p123456', '--', filepath])
}
const spawnPromise = (commmand, argument, timeoutMs = 30 * 1000) => {
  const stdout = Buffer.concat(output).toString('utf8')   // decode once as UTF-8
}
// add -- to avoid issues with filenames starting with -
await spawnPromise(_7z, ['x', '-o' + tempFolder, '-p123456', '-y', '--', filepath, coverFile])
```

```js
// fileLoader/zip.js
const solveBookTypeZip = async()
{
  // manually create folder to reduce disk active time when run in parallel
  await fs.promises.mkdir(tempFolder, { recursive: true })
}
```

4. Fix Racing Conditions in Saving `Setting.json`

When the program starts, it calls  `onMounted` (`./src/components/Setting.vue`). When there are additional settings 
to the default configuration, and when the language is changed, it calls `saveSettings`, and the following  
`handleLanguageChange(res.language)` also calls `saveSettings`. The racing condition causes settings appended in 
json format, such as ``{...}...}``. 

The solution is to use coalescing write: if there are multiple calls to `saveSettings` in a short period, only the last
call is saved. The function `ipcMain.handle('save-setting', (_e, receiveSetting))` (`./index.js`) is rewritten.

## New Features

1. Internal browser for searching manga tags

Add a browser component for easier updating manga tags directly from webpages. 

In the `bookdetail` UI, click the search icon to open the internal browser. The browser has a built-in adblocker. A
user search book titles in a webpage and clicks the confirm button to grab tags from the webpage.

* `/src/components/SearchDialogBrowser.vue` defines the browser component
  * url updates and mouse back/forward are defined in `./index.js` (search keyword 'sub browser')
  * the adblocker is added in `app.whenReady()` in `./index.js` (search keyword 'ElectronBlocker')
* `/src/components/SearchDialog.vue` parent component to manage the browser and search results
* `/src/scrapers/nhentai.ts`  scraper for nhentai.net
* `/src/scrapers/tag-dict.json`  tag dictionary for classifying tags. Data is processed from the
  api_dump_database_archive

How does it work:

a. browser starts with a default url with book title as the search keyword. User clicks pages and searches for the 
book. When the page is in the supported sites, the confirm button is enabled.

b. The 'confirm' button emits the "confirm" event => parent component "SearchDialog.vue" to grab tags. 


2. Shard cover folder & cover names

Why: Cover files are now stored in subfolders to avoid too many files in one folder. It is not an issue when the
number of files is small or when files are in ssd, but when there are more than 10K files in hdd, it can be slow to
access the folder. Especially the program enumerate the cover folder to delete unused files after a scan is completed.

Solution: default 2 hex digits (256 folders) to shard the cover files. For example, 500K images will be stored in 256
folders, each folder has about 2K files.

Assume 50 MB per manga on average, A library of 500K mangas will be about 25 TB.

Cover names are now `sha256(image buffer).webp'`. This makes migration easy as the `database.sqlite` stores the 
cover hash. 


3. Faster Startup

At the startup, the program calls `loadBookListFromDatabase` in `/index.js` to load all book entries from the 
database. The new approach uses SQL directly merge and update databases, reducing runtime from 3.61s to 0.39s 
when both db have 32K rows of data. 


The previous approach is to load all entries from `database.sqlite` into memory, and then it loops over the 
entries to merge and update `metadata.sqlite`. That's `O(n^2)` as shown below:

```js
// ./index.js
const _loadBookListFromDatabase = async () => {
  let bookList = await Manga.findAll()
  bookList = bookList.map(b => b.toJSON())
  let metadataList = await Metadata.findAll()
  metadataList = metadataList.map(m => m.toJSON())
  const bookListLength = bookList.length
  for (let i = 0; i < bookListLength; i++) {
    const book = bookList[i]
    const findMetadata = metadataList.find(m => m.hash === book.hash)
    if (findMetadata) {
      if (book.status === 'non-tag' && findMetadata.status !== 'non-tag') await Manga.update(findMetadata,
        { where: { id: book.id } })
      Object.assign(book, findMetadata)
    } else {
      setProgressBar((i + 1) / bookListLength)
      await Metadata.upsert(book)
    }
  }
}

```


4. Parallel Scanning/Rebuilding/Patching

Significantly speed up library scanning/rebuilding/patching mangas. Users can choose the concurrent read/write values in settings.

How it works:
Given a list of file paths, split the list into chunks. In each chunk, spawn 7z process (-mmt=1) to read files 
into RAM, calculate hash, and create thumbnails (sharp objects). Then, spawn tasks to write the thumbnails into disk.
At the end of each chunk, bulk update the database. It has a built-in aborter to avoid hanging 7z runs when the 
program is closed while the scanning is in progress.

The default concurrent read is 4, current write is 2, and db update is 1. We keep the concurrent limiter for the db 
writes as we haven't disable other buttons that may trigger a db write yet. 

User may choose the concurrent read/write values in settings. The sweet spot is 8 concurrent reads and 4 concurrent 
writes if db and cover folder are in SSD.

Users may want to pause antivirus auto scan on the library folder. Some software will rescan all files (possibly in
parallel) when the scanning is done or terminated, resulting in very busy disk spinning and
loud noise. For example, Norton uses `aswidsagent.exe` to scan all files that are touched by `7z` and can't be disabled.



Experiment

Force rebuild a library of 360 files (43.3 GB). The software, dbs, and cover folder are in SSD, but the library folder 
is in CMR HHD (7200 rpm). 

The sweet spot is 8 concurrent reads and 4 concurrent writes. Note, writing into HHD should have no more than 2
concurrent tasks to reduce random writes.

Higher scan/read values may not be better. Bottlenecks are cover image writes and the db batch write at the end of a 
batch. 

| scan  | read  | time(s)   |
|-------|-------|-----------|
| 4     | 2     | 21.77     |
| 4     | 4     | 19.36     |
| 6     | 4     | 14.13     |
| 8     | 2     | 15.90     |
| **8** | **4** | **11.36** |
| 8     | 8     | 11.28     |
| 16    | 4     | 11.10     |
| 16    | 16    | 11.84     |

Scanning 28,521 files (2.68TB) in HHD with 8 concurrent reads and 4 concurrent writes takes about 2816s, but using 4 
reads and 2 writes takes about 2732s. 

Related major functions:
```js
//index.js
ipcMain.handle('load-book-list', async (event, scan) => {}
ipcMain.handle('force-gene-book-list', async (event, arg) => {}
ipcMain.handle('patch-local-metadata', async (event, arg) => {}
```


5. New UI for Book Card

Replace "tagged"  with manga categories for more informative display. 

 