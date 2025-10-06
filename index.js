const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  shell,
  screen,
  Menu,
  clipboard,
  nativeImage,
  Tray,
  webContents,
  WebContentsView,
  net
} = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const fsp = fs.promises
const zlib = require('zlib')
const { brotliDecompress } = require('zlib')
const { promisify, format } = require('util')
const _ = require('lodash')
const { nanoid } = require('nanoid')
const sharp = require('sharp')
const { exec } = require('child_process')
const { createHash } = require('crypto')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { pack, unpack } = require('msgpackr')

const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')
const windowStateKeeper = require('electron-window-state')
const express = require('express')
const { performance } = require('node:perf_hooks')
const { prepareMangaModel, prepareMetadataModel, ensureMetaTable, installRevTriggers } = require('./modules/database')
const { prepareTemplate } = require('./modules/prepare_menu.js')
const {
  getBookFilelist,
  geneCover,
  geneCoverFromBuffer,
  getImageListByBook,
  deleteImageFromBook
} = require('./fileLoader/index.js')
const {
  STORE_PATH,
  isPortable,
  TEMP_PATH,
  COVER_PATH,
  VIEWER_PATH,
  prepareSetting,
  prepareCollectionList,
  preparePath
} = require('./modules/init_folder_setting.js')
const { findSameFile, makeShardedPath } = require('./fileLoader/folder.js')
const { ElectronBlocker } = require('@ghostery/adblocker-electron')
const { QueryTypes } = require('sequelize')
const { getMetadata, TITLE_MATCHER } = require('./src/matcher/index.js')

preparePath()
let setting = prepareSetting()
let collectionList = prepareCollectionList()

const Manga = prepareMangaModel(path.join(STORE_PATH, './database.sqlite'))
let metadataSqliteFile
if (setting.metadataPath) {
  metadataSqliteFile = path.join(setting.metadataPath, './metadata.sqlite')
} else {
  metadataSqliteFile = path.join(STORE_PATH, './metadata.sqlite')
}
let Metadata = prepareMetadataModel(metadataSqliteFile)


const getColumns = async (sequelize, tableName) => {
      const query = `PRAGMA table_info(${tableName})`
      const [results] = await sequelize.query(query)
      return results.map(column => column.name)
    }
;(async () => {

  await Manga.sequelize.query(`PRAGMA journal_mode=WAL;`)
  await Metadata.sequelize.query(`PRAGMA journal_mode=WAL;`)

  const columns = await getColumns(Manga.sequelize, 'Mangas')
  if (['hiddenBook', 'readCount'].some(c => !columns.includes(c))) {
    await Manga.sync({ alter: true })
  } else {
    await Manga.sync()
  }
  await Metadata.sync()
  await Manga.sequelize.query(`CREATE INDEX IF NOT EXISTS manga_hash_index ON Mangas (hash)`)

  // add meta table for cache
  await ensureMetaTable(Manga.sequelize)
  await installRevTriggers(Manga.sequelize, 'Mangas', 'mm')

  await ensureMetaTable(Metadata.sequelize)
  await installRevTriggers(Metadata.sequelize, 'Metadata', 'mm')


})()

const logFile = fs.createWriteStream(path.join(STORE_PATH, 'log.txt'), { flags: 'w' })
const logStdout = process.stdout
const logStderr = process.stderr

console.log = (...message) => {
  logFile.write(format(...message) + '\n')
  logStdout.write(format(...message) + '\n')
}

console.error = (...message) => {
  logFile.write(format(...message) + '\n')
  logStderr.write(format(...message) + '\n')
}

process
    .on('unhandledRejection', (reason, promise) => {
      console.log('Unhandled Rejection at:', promise, 'reason:', reason)
    })
    .on('uncaughtException', err => {
      console.log(err, 'Uncaught Exception thrown')
      process.exit(1)
    })

const sendMessageToWebContents = (message) => {
  console.log(message)
  mainWindow.webContents.send('send-message', message)
}

let mainWindow
let tray
let screenWidth
let sendImageLock = false

const createTray = () => {
  if (tray) return
  const iconPath = path.join(__dirname, 'public/icon.png')
  tray = new Tray(iconPath)
  tray.setToolTip('exhentai-manga-manager')
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.minimize()
      } else if (mainWindow.isMinimized()) {
        mainWindow.restore()
        mainWindow.setSkipTaskbar(false)
        mainWindow.focus()
      } else {
        mainWindow.show()
        mainWindow.setSkipTaskbar(false)
        mainWindow.focus()
      }
    }
  })
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'show window',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore()
          } else {
            mainWindow.show()
          }
          mainWindow.setSkipTaskbar(false)
          mainWindow.focus()
        }
      }
    },
    {
      label: 'exit',
      click: () => {
        mainWindow.close()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
}

const createWindow = () => {
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1560,
    defaultHeight: 1000
  })
  const win = new BrowserWindow({
    'x': mainWindowState.x,
    'y': mainWindowState.y,
    'width': mainWindowState.width,
    'height': mainWindowState.height,
    webPreferences: {
      webSecurity: app.isPackaged ? true : false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  })
  if (app.isPackaged) {
    win.loadFile('dist/index.html')
  } else {
    win.loadURL('http://localhost:5374')
  }
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  const menu = Menu.buildFromTemplate(prepareTemplate(win))
  Menu.setApplicationMenu(menu)
  win.webContents.on('did-finish-load', () => {
    const name = require('./package.json').name
    const version = require('./package.json').version
    win.setTitle(name + ' ' + version)
  })
  win.once('ready-to-show', () => {
    if (setting.minimizeOnStart) {
      if (setting.minimizeToTray) {
        createTray()
        win.hide()
        win.setSkipTaskbar(true)
      } else {
        win.minimize()
      }
    } else {
      win.show()
    }
  })
  win.on('minimize', (event) => {
    if (setting.minimizeToTray) {
      event.preventDefault()
      createTray()
      win.hide()
      win.setSkipTaskbar(true)
    }
  })
  win.on('restore', () => {
    win.show()
    win.setSkipTaskbar(false)
  })
  win.on('show', () => {
    win.setSkipTaskbar(false)
    mainWindowState.manage(win)
  })

  win.on('app-command', (_ev, cmd) => {
    const target = webContents.getFocusedWebContents()
    if (!target) return
    if (cmd === 'browser-backward' && target.navigationHistory.canGoBack?.()) {
      target.navigationHistory.goBack()
    } else if (cmd === 'browser-forward' && target.navigationHistory.canGoForward?.()) {
      target.navigationHistory.goForward()
    }
  })

  return win
}

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=65536')

// app.disableHardwareAcceleration()

async function setupAdblockAndGuards() {
  const ses = session.fromPartition('persist:eh-search')

  // 1) Adblock lists (add annoyance lists to catch overlays/in-page popups)
  const blocker = await ElectronBlocker.fromLists(fetch, [
    'https://easylist.to/easylist/easylist.txt',
    'https://easylist.to/easylist/easyprivacy.txt',
    'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    'https://ublockorigin.github.io/uAssets/filters/annoyances.txt',
  ], { enableCompression: true })

  blocker.enableBlockingInSession(ses)

  // 2) Deny permission prompts (notifications are a common nuisance pop)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    // Return false for everything by default (tighten later if needed)
    callback(false)
  })

  // 3) Disable Additional Popups/Windows
  app.on('web-contents-created', (_event, contents) => {
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  await setupAdblockAndGuards()
  const primaryDisplay = screen.getPrimaryDisplay()
  screenWidth = Math.floor(primaryDisplay.workAreaSize.width * primaryDisplay.scaleFactor)
  mainWindow = createWindow()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  }
})

app.on('ready', async () => {
  if (setting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: setting.proxy
    })
  }
  // session.defaultSession.loadExtension(path.join(__dirname, './devtools'))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async (e,) => {
  e.preventDefault()
  try {
    if (latestAppCache) {
      await saveAppCache(latestAppCache)
      console.log('Saved AppCache')
    }
  } catch (e) {
    console.log('Failed to save AppCache', e)
  } finally {
    app.exit(0)
  }

})


process.on('exit', () => {
  app.quit()
})


// base function
const loadBookListFromBrFile = async () => {
  try {
    const buffer = await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json.br'))
    const decodeBuffer = await promisify(brotliDecompress)(buffer)
    return JSON.parse(decodeBuffer.toString())
  } catch {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json'), { encoding: 'utf-8' }))
    } catch {
      return []
    }
  }
}

const loadLegecyBookListFromFile = async () => {
  const bookList = await loadBookListFromBrFile()
  try {
    shell.trashItem(path.join(STORE_PATH, 'bookList.json.br'))
    shell.trashItem(path.join(STORE_PATH, 'bookList.json'))
  } catch {
    console.log('Remove Legecy BookList Failed')
  }
  return bookList
}

async function ensureAttachedTx(sequelize, t, alias, filePath) {
  const rows = await sequelize.query('PRAGMA database_list', {
    type: QueryTypes.SELECT,
    transaction: t,
  })

  const hit = rows.find(r => r.name === alias)

  if (!hit) {
    await sequelize.query(`ATTACH DATABASE $p AS ${alias}`, { bind: { p: filePath }, transaction: t, })

  } else if (path.resolve(hit.file || '') !== path.resolve(filePath)) {
    // Attached to a different file → switch it
    await sequelize.query(`DETACH DATABASE ${alias}`, { transaction: t })
    await sequelize.query(`ATTACH DATABASE $p AS ${alias}`, {
      bind: { p: filePath },
      transaction: t,
    })
  }
}

const loadBookListFromDatabase = async () => {
  const tTotal0 = performance.now()

  // If DB is empty, seed from legacy source first (same behavior as before)
  const count = await Manga.count()
  if (count === 0) {
    const legacy = await loadLegecyBookListFromFile()
    if (legacy?.length) await saveBookListToDatabase(legacy)
  }


  const bookList = await Manga.sequelize.transaction(async (t) => {
    // Attach the metadata DB (if not already)
    await ensureAttachedTx(Manga.sequelize, t, 'meta', metadataSqliteFile)
    // upsert metadata table from the mangas table
    await Manga.sequelize.query(`
        INSERT INTO meta.Metadata (hash, title, status, rating, tags, title_jpn, filecount, posted, filesize,
                                   category, url, mark, createdAt, updatedAt)
        SELECT m.hash,
               m.title,
               m.status,
               m.rating,
               m.tags,
               m.title_jpn,
               m.filecount,
               m.posted,
               m.filesize,
               m.category,
               m.url,
               m.mark,
               m.createdAt,
               m.updatedAt
        FROM main.Mangas AS m
        --- the hash column in the Mangas table is not unique, so we pick the earliest row
        WHERE NOT EXISTS (SELECT 1 FROM meta.Metadata AS md WHERE md.hash = m.hash)
          AND m.rowid = (SELECT MIN(m2.rowid)
                         FROM main.Mangas m2
                         WHERE m2.hash = m.hash);
    `, { transaction: t })
    /** update mangas table from the metadata table
     * replace rows in the Manga table from the Metadata
     * if there are matches and status=non-tag in the Mangas but status!=non-tag in Metadata  */
    // @formatter:off
    await Manga.sequelize.query(`
      UPDATE main.Mangas AS m
      SET
        title     = COALESCE(md.title,     m.title),
        rating    = COALESCE(md.rating,    m.rating),
        tags      = COALESCE(md.tags,      m.tags) ,
        title_jpn = COALESCE(md.title_jpn, m.title_jpn),
        filecount = COALESCE(md.filecount, m.filecount),
        posted    = COALESCE(md.posted,    m.posted),
        filesize  = COALESCE(md.filesize,  m.filesize),
        category  = COALESCE(md.category,  m.category),
        url       = COALESCE(md.url,       m.url),
        mark      = COALESCE(md.mark,      m.mark),
        status    = COALESCE(md.status,    m.status),
        createdAt = COALESCE(md.createdAt,    m.createdAt),
        updatedAt = COALESCE(md.updatedAt,    m.updatedAt)
      FROM meta.Metadata AS md
      WHERE md.hash = m.hash
      AND m.status = 'non-tag'
      AND COALESCE(md.status, 'non-tag') <> 'non-tag'; --- not equal to 'non-tag'
    `, { transaction: t })
    
    // don't use this one, we choose the metadata table as the source of truth
    // return await Manga.findAll({ raw: true })
    // 26 columns in total; check the table if update the script;
    return await Manga.sequelize.query(`
      SELECT
        m.id, m.hash, m.coverPath, m.filepath, m.type,   m.pageCount,
        m.bundleSize, m.mtime,m.coverHash, m.hiddenBook, m.readCount, m.exist,m.date,
        COALESCE(md.title,     m.title)        AS title,
        COALESCE(md.status,    m.status)       AS status,
        COALESCE(md.rating,    m.rating)       AS rating,
        COALESCE(md.tags,      m.tags, '{}')   AS tags,
        COALESCE(md.title_jpn, m.title_jpn)    AS title_jpn,
        COALESCE(md.filecount, m.filecount)    AS filecount,
        COALESCE(md.posted,    m.posted)       AS posted,
        COALESCE(md.filesize,  m.filesize)     AS filesize,
        COALESCE(md.category,  m.category)     AS category,
        COALESCE(md.url,       m.url)          AS url,
        COALESCE(md.mark,      m.mark)         AS mark,
        COALESCE(md.createdAt,    m.createdAt) AS createdAt,
        COALESCE(md.updatedAt,    m.updatedAt) AS updatedAt
      FROM main.Mangas m
      LEFT JOIN meta.Metadata md ON md.hash = m.hash
    `, { type: QueryTypes.SELECT, transaction: t  });
  })
  const totalS = (performance.now() - tTotal0) / 1000;
  // sendMessageToWebContents(`loadBookListFromDatabase Completed in : ${totalS.toFixed(2)} s`);;
  for (let i = 0; i < bookList.length; i++) {
    const b = bookList[i];
    b.tags = JSON.parse(b.tags || '{}');
  }
  // flag missing books
  await markMissingBooksStatus(bookList)
  return bookList;
};

async function markMissingBooksStatus(bookList) {
  // only check existence and don't check contents
  const limit = createLimiter(Math.min(Number(navigator.hardwareConcurrency), 4)) // in case the files are in smr hdd
  const tasks = bookList.map((b) => limit(async () => {
    const p = String(b.filepath || '')
    if (!p) { b.category = 'Missing'; b.exist = false }
    try {
      // access() is enough to tell existence for file or folder
      await fsp.access(p)
      b.exist = true
    } catch {
      b.category = 'Missing'
      b.exist = false
    }
  }))
  await Promise.all(tasks)
}

const saveBookListToDatabase = async (data) => {
  console.log('Empty Exist BookList and Saved New BookList')
  await Manga.destroy({ truncate: true })
  await Manga.bulkCreate(data)
}

const saveBookToDatabase = async (book) => {
  await Manga.update(book, { where: { id: book.id } })
  await Metadata.upsert(book)
  console.log(`Saved ${book.title}`)
}

const setProgressBar = (progress) => {
  mainWindow.setProgressBar(progress)
  mainWindow.webContents.send('send-action', {
    action: 'send-progress',
    progress
  })
}

const clearFolder = async (Folder) => {
  try {
    await fs.promises.rm(Folder, { recursive: true, force: true })
    await fs.promises.mkdir(Folder, { recursive: true })
  } catch (err) {
    console.log(err)
  }
}


/**=========    library and metadata  ================*/
// helpers for parallel scan
// Small concurrency limiter (p-limit style) with zero deps
function createLimiter(concurrency) {
  let active = 0
  const queue = []
  const next = () => {
    active--
    if (queue.length > 0) queue.shift()()
  }
  return fn =>
      new Promise((resolve, reject) => {
        const run = () => {
          active++
          Promise.resolve()
              .then(fn)
              .then((v) => {
                next();
                resolve(v)
              }, (e) => {
                next();
                reject(e)
              })
        }
        if (active < concurrency) run()
        else queue.push(run)
      })
}


async function coverAndHashInMem(filepath, type,  opts={} ) {
  const { hash, coverPath, pageCount, bundleSize, mtime, coverHash, coverSharp } = await geneCoverFromBuffer(filepath, type,  opts)
  return { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp }
}

// ----- additional helpers
async function scanLibraryFilesWithExclude() {
  // helper: normalize to array
  const toArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);
  // helper: dedupe by key
  const uniqueBy = (arr, key) =>
    Array.from(new Map(arr.map((x) => [x[key], x])).values());
  // collapse paths
  function isSubpath(parent, child, { includeSelf = false } = {}) {
    // Normalize to absolute; keep case-insensitive compare on Windows
    const from = path.resolve(parent);
    const to = path.resolve(child);

    const rel = path.relative(from, to);
    if (rel === "") return !!includeSelf; // same path
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  }
  function collapseRoots(paths) {
    const abs = [...new Set(paths.map((p) => path.resolve(p)))].sort();
    const keep = [];
    outer: for (const p of abs) {
      for (const k of keep)
        if (isSubpath(k, p, { includeSelf: false })) continue outer;
      keep.push(p);
    }
    return keep;
  }
  let libraries = toArray(setting.libraries);
  if (!libraries) return [];
  libraries = collapseRoots(libraries)
  // let list = await getBookFilelist(setting.library)
  const lists = await Promise.all(libraries.map((lib) => getBookFilelist(lib)));
  let list = lists.flat();

  // optional: dedupe in case libraries overlap
  list = uniqueBy(list, "filepath");

  const pattern = (setting.excludeFile || "").trim();
  if (pattern) {
    try {
      const excludeRe = new RegExp(pattern);
      list = list.filter((item) => !excludeRe.test(item.filepath));
    } catch (e) {
      console.warn(
        "Illegal regular expression in setting.excludeFile:",
        e?.message,
      );
    }
  }
  return list;
}

// ----- Abortable context for parallel scan

// Track one active scan
let context = null
function createAbortableContext(event) {
  // Abort prior scan if any
  if (context?.controller && !context.controller.signal.aborted) {
    context.controller.abort()
  }

  const controller = new AbortController()
  const children = new Set()     // track spawned child processes
  const tempDirs = new Set()     // track temp dirs you create
  const onAbort = () => {
    // Kill children on abort
    for (const cp of children) {
      // Try a graceful kill first, then force if needed
      if (!cp.killed) cp.kill('SIGTERM')
      // In case SIGTERM isn't supported or process ignores it:
      setTimeout(() => { try { if (!cp.killed) cp.kill('SIGKILL') } catch {} }, 5000)
    }
  }
  controller.signal.addEventListener('abort', onAbort, { once: true })

  // Abort if the window/renderer goes away
  const sender = event?.sender
  if (sender) {
    const abortOnDestroyed = () => controller.abort()
    sender.once('destroyed', abortOnDestroyed)
    // Ensure we remove the listener on cleanup if not destroyed
    controller.signal.addEventListener('abort', () => {
      try { sender.removeListener?.('destroyed', abortOnDestroyed) } catch {}
    }, { once: true })
  }

  // Abort on app quit
  const abortOnQuit = () => controller.abort()
  app.once('before-quit', abortOnQuit)
  controller.signal.addEventListener('abort', () => {
    try { app.removeListener('before-quit', abortOnQuit) } catch {}
  }, { once: true })

  context = { controller, children, tempDirs }
  return context
}


// main function
ipcMain.handle('load-book-list', async (event, scan) => {
  if (scan) {
    // scans all files in the library folder, but it doesn't verify the db's entry exists on disk here,
    // missing books are flagged in `remove-missing-records`
    sendMessageToWebContents('Start loading library')

    const context = createAbortableContext(event)
    const { signal } = context.controller
    try{
      const bookList = await Manga.findAll({ raw: true })
      const byFilepath = new Map(bookList.map(b => [b.filepath, b]))
      const byId = new Map(bookList.map(b => [b.id, b]))

      let list = await scanLibraryFilesWithExclude()
      const listLength = list.length
      sendMessageToWebContents(`Load ${listLength} book from library`)
      if (listLength === 0) {
        setProgressBar(-1)
        return await loadBookListFromDatabase()
      }

      // Concurrency knobs:
      // - workLimit controls parallel file processing (cover gen + hashing + file I/O)
      // - dbLimit serializes all DB writes (SQLite friendliness)
      const tTotal0 = performance.now();
      const workLimit = createLimiter(setting.concurrentScan)
      const coverLimit = createLimiter(setting.concurrentWrite)
      const dbLimit = createLimiter(1)
      const BATCH_SIZE = 50 // don't go high as db writes the whole batch at once
      let processed = 0

       // tiny helper: cheap existence probe
      const pathExists = async (p) => {
        try { await fs.promises.stat(p); return true; }
        catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }
      };

      for (let offset = 0; offset < listLength; offset += BATCH_SIZE) {
        signal?.throwIfAborted?.()
        const chunk = list.slice(offset, Math.min(offset + BATCH_SIZE, listLength))
        const chunkBooks = []

        const chunkTasks = chunk.map(({ filepath, type }, j) =>{
            // IMPORTANT: return the promise from workLimit so Promise.allSettled waits for it
            return workLimit(async () => {
              signal?.throwIfAborted?.()
              const globalIdx = offset + j
              try {
                // Path already known
                let found = byFilepath.get(filepath)
                if (found) {
                  found.exist = true
                  if (isPortable) {
                    const newCoverPath = makeShardedPath(COVER_PATH, path.basename(found.coverPath))
                    if (found.coverPath !== newCoverPath) {
                      found.coverPath = newCoverPath
                      await dbLimit(() =>
                          Manga.update({ coverPath: newCoverPath }, { where: { id: found.id } })
                      )
                    }
                  }
                  return
                }
                // New file path: relocated or duplicated ?
                // identical files in different folders will also be found
                const existingManga = await findSameFile(filepath, type, Manga)
                if (existingManga) {
                  const prev = byId.get(existingManga.id) || null
                  if (prev) {
                    // file is relocated if the filepath doesn't exist
                    const exist = await pathExists(prev.filepath)
                    if(!exist){
                      prev.exist = true
                      const newCoverPath = makeShardedPath(COVER_PATH, path.basename(prev.coverPath))
                      prev.coverPath = newCoverPath
                      prev.filepath = filepath
                      byFilepath.set(filepath, prev)
                      await dbLimit(() =>
                        Manga.update({ filepath:filepath, coverPath: newCoverPath }, { where: { id: existingManga.id }})
                      )
                      return
                  }
                  } //else: duplicated file, continue to add it as a new entry
                }
                // Brand-new file: run the atomic op (cover -> hash -> temp cleanup)
                const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } =
                    await coverAndHashInMem(filepath, type, { signal })

                if (coverPath && hash) {
                  const id = nanoid()
                  const newBook = {
                    title: path.basename(filepath),
                    coverPath,
                    hash,
                    filepath,
                    type,
                    id,
                    pageCount,
                    bundleSize,
                    mtime: mtime.toJSON(),
                    coverHash,
                    status: 'non-tag',
                    exist: true,
                    date: Date.now(),
                  }

                  await coverLimit(async () => {
                    await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })
                    await coverSharp.toFile(coverPath)
                  })
                  signal?.throwIfAborted?.()
                  // delay to batch end
                  // await dbLimit(() => Manga.create(newBook))
                  chunkBooks.push(newBook)
                  byFilepath.set(filepath, newBook)
                  byId.set(id, newBook)
                }else{
                  sendMessageToWebContents(
                    `Load ${filepath} failed because coverPath or hash is null, ${globalIdx + 1} of ${listLength}`
                  )
                }
              } catch (e) {
                if (e?.name === 'AbortError') throw e
                sendMessageToWebContents(
                    `Load ${filepath} failed because ${e?.message || e}, ${globalIdx + 1} of ${listLength}`
                )
              }
            }
            )}
            )

        const results = await Promise.allSettled(chunkTasks)

         // If any task threw AbortError, bail out early
        if (results.some(r => r.status === 'rejected' && r.reason?.name === 'AbortError')) {
          throw Object.assign(new Error('Scan aborted'), { name: 'AbortError' })
        }
        // Bulk insert all rows at once
        // keep the dbLimit until all other buttons are not disabled
        if (chunkBooks.length > 0) {
          await dbLimit(() =>
            Manga.sequelize.transaction(async (t) => {
              await Manga.bulkCreate(chunkBooks, {
                transaction: t,
                validate: false,        // false if skip per-row validators (trusted inputs), slightly faster
                individualHooks: false, // skip per-row hooks
                returning: false,       // don’t fetch inserted rows back
               })
              })
            )
        }

        processed += chunk.length
        setProgressBar(processed / listLength)
        try { await clearFolder(TEMP_PATH) } catch {}
      }

      // Final cleanup + timing
      try { await clearFolder(TEMP_PATH) } catch {}
      const totalS = (performance.now() - tTotal0) / 1000;
      sendMessageToWebContents(`Completed in : ${totalS.toFixed(2)} s`);
    }
    finally{
    setProgressBar(-1)
    }
  }
  return await loadBookListFromDatabase()
})

ipcMain.handle('force-gene-book-list', async (event, arg) => {
  // it finds duplicated files in different folders
  await Manga.destroy({ truncate: true })
  await Manga.sequelize.query(`DROP INDEX IF EXISTS manga_hash_index`)

  await clearFolder(TEMP_PATH)
  await clearFolder(COVER_PATH)
  sendMessageToWebContents('Start loading library')

  const context = createAbortableContext(event)
  const { signal } = context.controller

  const list = await scanLibraryFilesWithExclude()
  const listLength = list.length

  sendMessageToWebContents(`Load ${listLength} book from library`)

  if (listLength === 0) {
    setProgressBar(-1)
    return await loadBookListFromDatabase()
  }

  const tTotal0 = performance.now()
  const workLimit = createLimiter(setting.concurrentScan)
  const coverLimit = createLimiter(setting.concurrentWrite) // avoid HDD IO spike
  const dbLimit = createLimiter(1) // serialize writes for SQLite
  const BATCH_SIZE = 50 // don't go high as db writes the whole batch at once
  let processed = 0

  for (let offset = 0; offset < listLength; offset += BATCH_SIZE) {
    signal?.throwIfAborted?.()
    const chunk = list.slice(offset, Math.min(offset + BATCH_SIZE, listLength))

    // Collect rows that are ready to insert (cover already written)
    const chunkBooks = []

    const chunkTasks = chunk.map(({ filepath, type }, j) =>{
        return workLimit(async () => {
          signal?.throwIfAborted?.()
          const globalIdx = offset + j
          try {
            // Always rebuild cover + hash
            const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } =
                await coverAndHashInMem(filepath, type, { signal })

            if (coverPath && hash) {
              const id = nanoid()
              const newBook = {
                title: path.basename(filepath),
                coverPath,
                hash,
                filepath,
                type,
                id,
                pageCount,
                bundleSize,
                mtime: mtime.toJSON(),
                coverHash,
                status: 'non-tag',
                date: Date.now(),
              }

              await coverLimit(async () => {
                // sharded path may not exist yet
                await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })
                await coverSharp.toFile(coverPath)
              })

              // signal?.throwIfAborted?.()
              // await dbLimit(() => Manga.create(newBook))
              chunkBooks.push(newBook)
            } else{
              sendMessageToWebContents(
                `Load ${filepath} failed because coverPath or hash is null, ${globalIdx + 1} of ${listLength}`
              )
            }
          } catch (e) {
            if (e?.name === 'AbortError') throw e
            sendMessageToWebContents(
                `Rebuild ${filepath} failed because ${e?.message || e}, ${globalIdx + 1} of ${listLength}`
            )
          }
        })
    })

    const results = await Promise.allSettled(chunkTasks)
    if (results.some(r => r.status === 'rejected' && r.reason?.name === 'AbortError')) {
          throw Object.assign(new Error('Scan aborted'), { name: 'AbortError' })
    }
    // Bulk insert all rows at once
    // keep the dbLimit until all other buttons are not disabled
    if (chunkBooks.length > 0) {
      await dbLimit(() =>
        Manga.sequelize.transaction(async (t) => {
          await Manga.bulkCreate(chunkBooks, {
            transaction: t,
            validate: false,        // false if skip per-row validators (trusted inputs), slightly faster
            individualHooks: false, // skip per-row hooks
            returning: false,       // don’t fetch inserted rows back
           })
          })
        )
    }

    processed += chunk.length
    setProgressBar(processed / listLength)

    // Batch cleanup to keep disk quiet
    try {  await clearFolder(TEMP_PATH)  } catch {}
  }

  // Final cleanup + timing
  try { await clearFolder(TEMP_PATH) } catch {}
  await Manga.sequelize.query(`CREATE INDEX IF NOT EXISTS manga_hash_index ON Mangas(hash)`)

  setProgressBar(-1)

  const totalS = (performance.now() - tTotal0) / 1000
  sendMessageToWebContents(`Completed in : ${totalS.toFixed(2)} s`);
  return await loadBookListFromDatabase()
})

ipcMain.handle('patch-local-metadata', async (event, arg) => {
  // rebuild books in the current database
  const bookList = await loadBookListFromDatabase()
  const bookListLength = bookList.length
  await clearFolder(TEMP_PATH)
  await clearFolder(COVER_PATH)

  const context = createAbortableContext(event)
  const { signal } = context.controller


  const workLimit = createLimiter(setting.concurrentScan)
  const coverLimit = createLimiter(setting.concurrentWrite) // avoid HDD IO spike
  const dbLimit = createLimiter(1)
  const BATCH_SIZE = 100
  let processed = 0
  // tiny helper: cheap existence probe
  const pathExists = async (p) => {
    try { await fs.promises.stat(p); return true; }
    catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }
  };

  for (let offset = 0; offset < bookListLength; offset += BATCH_SIZE) {
    signal?.throwIfAborted?.()
    const chunk = bookList.slice(offset, Math.min(offset + BATCH_SIZE, bookListLength))
    const chunkTasks = chunk.map((book, j) =>{
      return workLimit(async () => {
          signal?.throwIfAborted?.()
          try {
            console.log("patching ", book)
            const { filepath } = book;
            // Lazy existence check (skip fast if missing)
            const exists = await pathExists(filepath);
            if (!exists) {
              sendMessageToWebContents(`Skip (missing): ${filepath}`);
              return; // no DB write, no cover
            }
            const type = book.type || 'archive';
            const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } =
                await coverAndHashInMem(filepath, type, { signal })
            _.assign(book, { type, coverPath, hash, pageCount, bundleSize, mtime: mtime.toJSON(), coverHash })

            await coverLimit(async () => {
                // sharded path may not exist yet
                await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })
                await coverSharp.toFile(coverPath)
              })
            signal?.throwIfAborted?.()
            await dbLimit(() => saveBookToDatabase(book))
          } catch(e){
            if (e?.name === 'AbortError') throw e;
            // Treat missing mid-pipeline as skip; otherwise log the failure
            if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
              sendMessageToWebContents(`Skip (disappeared): ${filepath}`);
              return;
            }
            sendMessageToWebContents(`Patch ${bookList[i].filepath} failed because ${e}`)
          }
      })
    })
    const results = await Promise.allSettled(chunkTasks)

    if (results.some(r => r.status === 'rejected' && r.reason?.name === 'AbortError')) {
      throw Object.assign(new Error('Scan aborted'), { name: 'AbortError' });
    }
    processed += chunk.length
    setProgressBar(processed / bookListLength)
  }

  await clearFolder(TEMP_PATH)
  setProgressBar(-1)
  return bookList
})


ipcMain.handle('_patch-local-metadata', async (event, arg) => {
  const bookList = await loadBookListFromDatabase()
  const bookListLength = bookList.length
  await clearFolder(TEMP_PATH)
  await clearFolder(COVER_PATH)

  for (let i = 0; i < bookListLength; i++) {
    try {
      const book = bookList[i]
      let { filepath, type } = book
      if (!type) type = 'archive'
      const { targetFilePath, coverPath, pageCount, bundleSize, mtime, coverHash } = await geneCover(filepath, type)
      if (targetFilePath && coverPath) {
        const hash = createHash('sha1').update(fs.readFileSync(targetFilePath)).digest('hex')
        _.assign(book, { type, coverPath, hash, pageCount, bundleSize, mtime: mtime.toJSON(), coverHash })
        await saveBookToDatabase(book)
      }
      if ((i + 1) % 50 === 0) await clearFolder(TEMP_PATH)
      setProgressBar(i / bookListLength)
    } catch (e) {
      sendMessageToWebContents(`Patch ${bookList[i].filepath} failed because ${e}`)
    }
  }

  await clearFolder(TEMP_PATH)
  setProgressBar(-1)
  return bookList
})

ipcMain.handle('patch-local-metadata-by-book', async (event, book) => {
  let { filepath, type } = book
  if (!type) type = 'archive'
  try {
    const { targetFilePath, coverPath, pageCount, bundleSize, mtime, coverHash } = await geneCover(filepath, type)
    if (targetFilePath && coverPath) {
      const hash = createHash('sha1').update(fs.readFileSync(targetFilePath)).digest('hex')
      await clearFolder(TEMP_PATH)
      return Promise.resolve({ coverPath, hash, pageCount, bundleSize, mtime: mtime.toJSON(), coverHash })
    }
  } catch (e) {
    sendMessageToWebContents(`Patch ${book.filepath} failed because ${e}`)
    await clearFolder(TEMP_PATH)
    return Promise.reject()
  }
})

// Function to read the .ehviewer file
function getEhviewerDataManually(dir) {
  try {
    const filePath = path.join(dir, '.ehviewer')
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf-8')
      const lines = fileContent.split('\n')
      if (lines.length >= 4) {
        const gid = lines[2].trim()
        const token = lines[3].trim()
        return { gid, token }
      }
    }
    return null
  } catch (error) {
    console.error('Failed to read .ehviewer file:', error)
    return null
  }
}

ipcMain.handle('get-ehviewer-data', async (event, dir) => {
  return getEhviewerDataManually(dir)
})

ipcMain.handle('get-ex-webpage', async (event, { url, cookie }) => {
  if (setting.proxy) {
    return await fetch(url, {
      headers: {
        Cookie: cookie
      },
      agent: new HttpsProxyAgent(setting.proxy)
    })
    .then(async res => {
      const result = await res.text()
      if (!result) throw new Error('Empty response, maybe the cookie is expired')
      return result
    })
    .catch(e => {
      sendMessageToWebContents(`Get ex page failed because ${e}`)
    })
  } else {
    return await fetch(url, {
      headers: {
        Cookie: cookie
      }
    })
    .then(async res => {
      const result = await res.text()
      if (!result) throw new Error('Empty response, maybe the cookie is expired')
      return result
    })
    .catch(e => {
      sendMessageToWebContents(`Get ex page failed because ${e}`)
    })
  }
})

ipcMain.handle('post-data-ex', async (event, { url, data }) => {
  if (setting.proxy) {
    return await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Content-Type': 'application/json'
      },
      agent: new HttpsProxyAgent(setting.proxy)
    })
    .then(res => res.text())
    .catch(e => {
      sendMessageToWebContents(`Get ex data failed because ${e}`)
    })
  } else {
    return await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Content-Type': 'application/json'
      }
    })
    .then(res => res.text())
    .catch(e => {
      sendMessageToWebContents(`Get ex data failed because ${e}`)
    })
  }
})

ipcMain.handle('save-book', async (event, book) => {
  return await saveBookToDatabase(book)
})

// home
// used in FolderTree.vue, but not anymore

ipcMain.handle('get-additional-folder-trees', async (_event) => {
  return await Manga.sequelize.transaction(async (t) => {
    await ensureAttachedTx(Manga.sequelize, t, 'meta', metadataSqliteFile)

    // Build a single source table for all tag queries
    await Manga.sequelize.query(
      `
      CREATE TEMP TABLE _src AS
      SELECT
        m.id,
        COALESCE(md.tags, m.tags) AS tags_json
      FROM Mangas AS m
      LEFT JOIN meta.Metadata AS md
        ON md.hash = m.hash
      WHERE m.exist = 1
      `,
      { transaction: t }
    )

    try {
      const artistRows = await Manga.sequelize.query(
        `
        SELECT
          LOWER(TRIM(a.value)) AS name,
          COUNT(DISTINCT s.id) AS count
        FROM _src AS s
        JOIN json_each(s.tags_json, '$.artist') AS a
        WHERE json_valid(s.tags_json)
          AND a.value IS NOT NULL
          AND TRIM(a.value) <> ''
        GROUP BY name COLLATE NOCASE
        ORDER BY name COLLATE NOCASE ASC
        `,
        { type: QueryTypes.SELECT, transaction: t }
      )

      const groupRows = await Manga.sequelize.query(
        `
        SELECT
          LOWER(TRIM(g.value)) AS name,
          COUNT(DISTINCT s.id) AS count
        FROM _src AS s
        JOIN json_each(s.tags_json, '$.group') AS g
        WHERE json_valid(s.tags_json)
          AND g.value IS NOT NULL
          AND TRIM(g.value) <> ''
        GROUP BY name COLLATE NOCASE
        ORDER BY name COLLATE NOCASE ASC
        `,
        { type: QueryTypes.SELECT, transaction: t }
      )

      const parodyRows = await Manga.sequelize.query(
        `
        SELECT
          LOWER(TRIM(p.value)) AS name,
          COUNT(DISTINCT s.id) AS count
        FROM _src AS s
        JOIN json_each(s.tags_json, '$.parody') AS p
        WHERE json_valid(s.tags_json)
          AND p.value IS NOT NULL
          AND TRIM(p.value) <> ''
        GROUP BY name COLLATE NOCASE
        ORDER BY name COLLATE NOCASE ASC
        `,
        { type: QueryTypes.SELECT, transaction: t }
      )

      return {
        artistList: artistRows.map(r => ({ name: r.name, count: Number(r.count) })),
        groupList:  groupRows.map(r => ({ name: r.name, count: Number(r.count) })),
        parodyList: parodyRows.map(r => ({ name: r.name, count: Number(r.count) })),
      }
    } finally {
      // Always clean up the temp table
      await Manga.sequelize.query(`DROP TABLE IF EXISTS _src`, { transaction: t })
    }
  })
})


ipcMain.handle('load-collection-list', async (event, arg) => {
  return collectionList
})

ipcMain.handle('save-collection-list', async (event, list) => {
  collectionList = list
  return await fs.promises.writeFile(path.join(STORE_PATH, 'collectionList.json'), JSON.stringify(list, null, '  '), { encoding: 'utf-8' })
})

// detail
ipcMain.handle('open-url', async (event, url) => {
  shell.openExternal(url)
})

ipcMain.handle('show-file', async (event, filepath) => {
  shell.showItemInFolder(filepath)
})
ipcMain.handle('show-folder', async (event, folderpath) => {
  try{
    await shell.openPath(folderpath)
  }catch (e){
    console.log(`Failed to open folder ${folderpath} because ${e}`)
  }
})
ipcMain.handle('use-new-cover', async (event, filepath) => {
  const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(filepath))

  try {
    await fs.promises.copyFile(filepath, copyTempCoverPath)

    const coverBuffer = await sharp(copyTempCoverPath, { failOnError: false })
    .resize(500, 707, { fit: 'contain',background: '#303133' })

    const coverHash = createHash('sha256').update(fs.readFileSync(copyTempCoverPath)).digest('hex')
    const coverPath = makeShardedPath(COVER_PATH, coverHash + '.webp')
    await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })

    await coverBuffer.toFile(coverPath)
    return coverPath
  } catch (e) {
    sendMessageToWebContents(`Generate cover from ${filepath} failed because ${e}`)
  }
})

ipcMain.handle('open-local-book', async (event, filepath) => {
  exec(`${setting.imageExplorer} "${filepath}"`)
})

ipcMain.handle('delete-local-book', async (event, filepath) => {
    await Manga.destroy({ where: { filepath: filepath } })
    try {
      try {
        await shell.trashItem(filepath)
      } catch {
        await fs.promises.rm(filepath, { recursive: true, force: true })
      }
    } catch (e) {
      sendMessageToWebContents(`Delete ${filepath} failed because ${e}`)
    }
})

ipcMain.handle('move-local-book', async (event, oldPath, newFolder) => {
  try {
    const newFilePath = path.join(newFolder, path.basename(oldPath))
    if (oldPath !== newFilePath) {
      await fs.promises.rename(oldPath, newFilePath)
      sendMessageToWebContents("Move succeed")
      return newFilePath
    } else {
      sendMessageToWebContents(`Move failed because the new path is the same as the old path`)
      return false
    }
  } catch (e) {
    sendMessageToWebContents(`Move failed because ${e}`)
    return false
  }
})

// viewer
ipcMain.handle('load-manga-image-list', async (event, book) => {
  await clearFolder(VIEWER_PATH)

  const { filepath, type, id: bookId } = book
  const list = await getImageListByBook(filepath, type)

  sendImageLock = true
  ;(async () => {
    // 384 is the default 4K screen width divided by the default number of thumbnail columns
    const thumbnailWidth = _.isFinite(screenWidth / setting.thumbnailColumn) ? Math.floor(screenWidth / setting.thumbnailColumn) : 384
    const widthLimit = _.isNumber(setting.widthLimit) ? Math.ceil(setting.widthLimit) : screenWidth
    for (let index = 1; index <= list.length; index++) {
      if (sendImageLock) {
        let imageFilepath = list[index - 1].absolutePath
        const extname = path.extname(imageFilepath)
        if (imageFilepath.search(/[%#]/) >= 0 || type === 'folder') {
          const newFilepath = path.join(VIEWER_PATH, `rename_${nanoid(8)}${extname}`)
          await fs.promises.copyFile(imageFilepath, newFilepath)
          imageFilepath = newFilepath
        }
        let { width, height } = await sharp(imageFilepath, { failOnError: false }).metadata()
        if (widthLimit !== 0 && width > widthLimit) {
          height = Math.floor(height * (widthLimit / width))
          width = widthLimit
          const resizedFilepath = path.join(VIEWER_PATH, `resized_${nanoid(8)}.jpg`)
          switch (extname) {
            case '.gif':
              break
            default:
              await sharp(imageFilepath, { failOnError: false })
                .resize({ width })
                .toFile(resizedFilepath)
              imageFilepath = resizedFilepath
              break
          }
        }
        mainWindow.webContents.send('manga-image', {
          id: `${bookId}_${index}`,
          index,
          relativePath: list[index - 1].relativePath,
          filepath: imageFilepath,
          width, height
        })
        ;(async () => {
          let thumbnailPath = path.join(VIEWER_PATH, `thumb_${nanoid(8)}.jpg`)
          switch (extname) {
            case '.gif':
              thumbnailPath = imageFilepath
              break
            default:
              await sharp(imageFilepath, { failOnError: false })
                .resize({ width: thumbnailWidth })
                .toFile(thumbnailPath)
              break
          }
          mainWindow.webContents.send('manga-thumbnail-image', {
            id: `${bookId}_${index}`,
            index,
            relativePath: list[index - 1].relativePath,
            filepath: imageFilepath,
            thumbnailPath,
          })
        })()
      }
    }
  })()

  return list
})

ipcMain.handle('release-sendimagelock', () => {
  sendImageLock = false
})

ipcMain.handle('delete-image', async (event, filename, filepath, type) => {
  return await deleteImageFromBook(filename, filepath, type)
})

// setting
ipcMain.handle('select-folder', async (event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openDirectory']
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})
ipcMain.handle('fs:exists-batch', async (event, paths) => {
  //check a batch files existence
  // paths =[path1, path2, ...]
  // out: [{path, exists}]
  if(!paths.length) return
  return await Promise.all(paths.map(async p => {
    try {
      await fs.promises.access(p)
      return { path: p, exists: true }
    } catch {
      return { path: p, exists: false }
    }
  }))
})


ipcMain.handle('select-file', async (event, title, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openFile'],
    filters
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('load-setting', async (event, arg) => {
  return setting
})


/** Exclusive save setting with coalescing (last write wins)
 * If multiple save-settings calls happen in a short time, only the last one is applied and written to setting.json
 * This avoids the race condition where one overlaps the other, resulting in a wrong setting.json
 * For example: call saveSetting() before/after handleLanguageChange(res.language), the setting.json will be  {...}...}
 * */

let writing = false;
let pending = null;
let drainPromise = null;
const SETTINGS_FILE = path.join(STORE_PATH, 'setting.json');

async function atomicWriteSettings(obj) {
  const json = JSON.stringify(obj, null, 2) + '\n';
  const tmp = SETTINGS_FILE + '.tmp';
  await fs.promises.writeFile(tmp, json, 'utf-8');
  await fs.promises.rename(tmp, SETTINGS_FILE);
}

async function applySideEffects(setting, receiveSetting) {
  if (receiveSetting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: receiveSetting.proxy
    })
  }
  if (receiveSetting.metadataPath !== setting.metadataPath) {
    Metadata = prepareMetadataModel(path.join(receiveSetting.metadataPath, './metadata.sqlite'))
    await Metadata.sync()
  }
  if (receiveSetting.enabledLANBrowsing !== setting.enabledLANBrowsing) {
    if (receiveSetting.enabledLANBrowsing) {
      enableLANBrowsing()
    } else {
      if (LANBrowsingInstance?.listening) {
        LANBrowsingInstance.close(() => {
          sendMessageToWebContents('LAN browsing closed')
        })
      }
    }
  }
  if (receiveSetting.startOnLogin !== setting.startOnLogin) {
    app.setLoginItemSettings({
      openAtLogin: receiveSetting.startOnLogin
    })
  }
  if (tray && !receiveSetting.minimizeToTray) {
    tray.destroy()
    tray = null
  }
}

async function saveSettingExclusive(next) {
  pending = next;            // keep only the latest payload
  if (writing) return drainPromise;

  writing = true;
  drainPromise = (async () => {
    try {
      while (pending) {
        const patch  = pending;  // snapshot latest
        pending = null;
        const prev = setting;
        const merged = { ...prev, ...patch };
        await applySideEffects(prev, merged); // missing settings in the later will not override the previous ones
        await atomicWriteSettings(merged);
        setting = merged;
      }
    } finally {
      writing = false;
      drainPromise = null;
    }
  })();
  return drainPromise;
}

ipcMain.handle('save-setting', (_e, receiveSetting) => saveSettingExclusive(receiveSetting));

ipcMain.handle('export-database', async (event, folder) => {
  if (folder !== STORE_PATH && folder !== setting.metadataPath) {
    await fs.promises.copyFile(path.join(STORE_PATH, 'collectionList.json'), path.join(folder, 'collectionList.json'))
    await fs.promises.copyFile(metadataSqliteFile, path.join(folder, 'metadata.sqlite'))
    return true
  } else {
    sendMessageToWebContents('Export failed because the target folder is the same as the source folder')
    return false
  }
})

ipcMain.handle('import-database', async (event, arg) => {
  const { collectionListPath, metadataSqlitePath } = arg
  if (collectionListPath && metadataSqlitePath) {
    await Metadata.sequelize.close()
    await fs.promises.copyFile(collectionListPath, path.join(STORE_PATH, 'collectionList.json'))
    await fs.promises.copyFile(metadataSqlitePath, metadataSqliteFile)
    app.relaunch()
    app.exit(0)
  } else {
    sendMessageToWebContents('Import failed because the source folder is empty')
  }
})

function parseMetadata(metadata) {
  //   a row from db
  if (!metadata) return;
  const re = /'/g
  metadata.tags = {
    language: metadata.language ? JSON.parse(metadata.language.replace(re, '\"')) : undefined,
    parody: metadata.parody ? JSON.parse(metadata.parody.replace(re, '\"')) : undefined,
    character: metadata.character ? JSON.parse(metadata.character.replace(re, '\"')) : undefined,
    group: metadata.group ? JSON.parse(metadata.group.replace(re, '\"')) : undefined,
    artist: metadata.artist ? JSON.parse(metadata.artist.replace(re, '\"')) : undefined,
    male: metadata.male ? JSON.parse(metadata.male.replace(re, '\"')) : undefined,
    female: metadata.female ? JSON.parse(metadata.female.replace(re, '\"')) : undefined,
    mixed: metadata.mixed ? JSON.parse(metadata.mixed.replace(re, '\"')) : undefined,
    other: metadata.other ? JSON.parse(metadata.other.replace(re, '\"')) : undefined,
    cosplayer: metadata.cosplayer ? JSON.parse(metadata.cosplayer.replace(re, '\"')) : undefined,
    rest: metadata.rest ? JSON.parse(metadata.rest.replace(re, '\"')) : undefined
  }
  metadata.filecount = +metadata.filecount
  metadata.rating = +metadata.rating
  metadata.posted = +metadata.posted
  metadata.filesize = +metadata.filesize
  metadata.url = `https://exhentai.org/g/${metadata.gid}/${metadata.token}/`
  return metadata;
}

// TODO: add support for .ehviewer
ipcMain.handle("import-sqlite", async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "SQLite", extensions: ["sqlite"] }],
  });
  if (!result.canceled) {
    try {
      const rows = await Manga.sequelize.query(
        `SELECT *  FROM Mangas  WHERE status != 'tagged'`,
        { type: Manga.sequelize.QueryTypes.SELECT },
      );
      if (!rows.length) return;

      const dbPath = result.filePaths[0];
      const bookWithMetadata = await getMetadata(dbPath, rows);
      if(!bookWithMetadata) return
      for(const book of bookWithMetadata){
        const metadata = parseMetadata(book.metadata);

        const status = TITLE_MATCHER.decision.exact ===  book.matchedInfo.decision ? 'tagged' : TITLE_MATCHER.decision.review

        _.assign(book, _.pick(metadata,
            ['tags', 'title', 'title_jpn', 'filecount', 'rating', 'posted', 'filesize', 'category', 'url']),
            { status: status })
        await saveBookToDatabase(book)
      }
      //-------------------------
      setProgressBar(-1);
    } catch (e) {
      console.log(e);
    }
    return {
      success: true,
    };
  } else {
    return {
      success: false,
    };
  }
});
// TODO: should use cloneDeep(this.bookList)? DOes the ipc automatically clone the object?
// It seems across renderer ⇄ main, Electron uses the structured-clone algorithm, so that will be very expensive
ipcMain.handle('_import-sqlite', async (event, bookList) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'SQLite', extensions: ['sqlite'] }]
  })
  if (!result.canceled) {
    const db = await open({
      filename: result.filePaths[0],
      driver: sqlite3.Database
    })
    try {
      const re = /'/g
      const bookListLength = bookList.length
      for (let i = 0; i < bookListLength; i++) {
        const book = bookList[i]
        if (book.status !== 'tagged') {
          let metadata
          // 当book type为folder时，尝试获取.ehviewer数据
          if (book.type === 'folder') {
            const dirname = book.filepath
            const ehviewerData = getEhviewerDataManually(dirname)
            const { gid, token } = ehviewerData || {}
            if (gid && token) {
              metadata = await db.get('SELECT * FROM gallery WHERE gid = ? AND token = ?', [gid, token])
            }
          }
          if (metadata === undefined) {
            // remove file extension
            const filename = path.parse(book.title).name
            metadata = await db.get(`SELECT * FROM gallery WHERE torrents LIKE ?
                                                            OR title LIKE ?
                                                            OR title_jpn LIKE ?
                                                            OR thumb LIKE ?`,
              `%${filename}%`,
              `%${filename}%`,
              `%${filename}%`,
              `%${book.coverHash}%`
            )
          }

          if (metadata) {
            metadata.tags = {
              language: metadata.language ? JSON.parse(metadata.language.replace(re, '\"')) : undefined,
              parody: metadata.parody ? JSON.parse(metadata.parody.replace(re, '\"')) : undefined,
              character: metadata.character ? JSON.parse(metadata.character.replace(re, '\"')) : undefined,
              group: metadata.group ? JSON.parse(metadata.group.replace(re, '\"')) : undefined,
              artist: metadata.artist ? JSON.parse(metadata.artist.replace(re, '\"')) : undefined,
              male: metadata.male ? JSON.parse(metadata.male.replace(re, '\"')) : undefined,
              female: metadata.female ? JSON.parse(metadata.female.replace(re, '\"')) : undefined,
              mixed: metadata.mixed ? JSON.parse(metadata.mixed.replace(re, '\"')) : undefined,
              other: metadata.other ? JSON.parse(metadata.other.replace(re, '\"')) : undefined,
              cosplayer: metadata.cosplayer ? JSON.parse(metadata.cosplayer.replace(re, '\"')) : undefined,
              rest: metadata.rest ? JSON.parse(metadata.rest.replace(re, '\"')) : undefined,
            }
            metadata.filecount = +metadata.filecount
            metadata.rating = +metadata.rating
            metadata.posted = +metadata.posted
            metadata.filesize = +metadata.filesize
            metadata.url = `https://exhentai.org/g/${metadata.gid}/${metadata.token}/`
            _.assign(book, _.pick(metadata, ['tags', 'title', 'title_jpn', 'filecount', 'rating', 'posted', 'filesize', 'category', 'url']), { status: 'tagged' })
            await saveBookToDatabase(book)
          }
          setProgressBar(i / bookListLength)
        }
      }
      await db.close()
      setProgressBar(-1)
    } catch (e) {
      console.log(e)
      await db.close()
    }
    return {
      success: true,
      bookList
    }
  } else {
    return {
      success: false
    }
  }
})
/**=====  remove missing records button =============*/

ipcMain.handle('sqlite-vacuum-estimate', async () => {
  function asNum(x, d = 0) {
    const n = Number(x); return Number.isFinite(n) ? n : d
  }
  async function getVacuumStats(sequelize) {
    if (!sequelize) return null;

    // page_size / page_count / freelist_count are per-DB
    const [[psRow]] = await sequelize.query("PRAGMA page_size");
    const [[pcRow]] = await sequelize.query("PRAGMA page_count");
    const [[flRow]] = await sequelize.query("PRAGMA freelist_count");

    const pageSize = asNum(
      psRow.page_size ?? psRow.PAGE_SIZE ?? psRow[Object.keys(psRow)[0]],
      4096,
    );
    const pageCnt = asNum(
      pcRow.page_count ?? pcRow.PAGE_COUNT ?? pcRow[Object.keys(pcRow)[0]],
      0,
    );
    const freeCnt = asNum(
      flRow.freelist_count ??
        flRow.FREELIST_COUNT ??
        flRow[Object.keys(flRow)[0]],
      0,
    );

    const usedBytes = pageCnt * pageSize;
    const freeBytes = freeCnt * pageSize;
    return {
      freeMB: +(freeBytes / (1024 * 1024)).toFixed(1),
      freeRatio: usedBytes ? +(freeBytes / usedBytes).toFixed(3) : 0,
    };
  }

  const main = await getVacuumStats(Manga.sequelize).catch(() => null);
  const meta = await getVacuumStats(Metadata.sequelize).catch(() => null);
  return { main, meta  }
})

let lastScan = null;
ipcMain.handle("remove-missing-records", async (event, arg = {}) => {
  /** find files from the Mangas table that are missing on disk
   *  remove their covers and rows from Mangas and Metadata tables
   *  Dry run first to get counts, then confirm to actually delete
   * */
  // -- helpers to check cover & file path
  function norm(p) {
    if (!p) return "";
    const normalized = path.normalize(p).replace(/\\/g, "/");
    // 3) Windows is case-insensitive; compare in lowercase there
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
  function withTrail(p) {
    return p.endsWith("/") ? p : p + "/";
  }
  const normalizeCase = (s) =>
    process?.platform === "win32" ? String(s).toLowerCase() : String(s);

  function isInsideLibrary(filePath, libs = libraries) {
    if (!filePath || libs.length === 0) return false;
    const fileNorm = normalizeCase(norm(filePath));
    // trailing slash on libs ensures true “prefix as directory” semantics
    return libs.some((lib) => fileNorm.startsWith(lib));
  }

  const { confirm, vacuum } = arg;
  const sequelize = Manga.sequelize;
  const rawLibs = setting.libraries || [];
  const libraries = rawLibs
    .map((lib) => normalizeCase(withTrail(norm(lib))))
    .filter(Boolean);

  // ---- Phase 1: DRY RUN (scan + counts) ----
  if (!confirm) {
    // Grab what we need from Mangas
    const [rows] = await sequelize.query(` SELECT id, filepath FROM Mangas `, {
      raw: true,
    });

    // const idsToDelete = [];

    // flag missing files
    const limit = createLimiter(Math.min(os.cpus()?.length || 4, 4)); // in case the files are in smr hdd
    const tasks = rows.map((b) =>
      limit(async () => {
        const p = String(b.filepath || "");
        if (!p) {
          return b.id;
        }
        if (!isInsideLibrary(p, libraries)) {
          return b.id;
        }
        try {
          await fsp.access(p);
          return undefined; //exists
        } catch {
          return b.id;
        }
      }),
    );
    const idsToDelete = (await Promise.all(tasks)).filter(Boolean);
    // No need to update db ?
    // await Manga.update({ exist: false }, { where: { id: idsToDelete } });

    // check all covers in disk that are not referenced in Mangas
    let dirCovers = [];
    try {
      dirCovers = await fs.promises.readdir(COVER_PATH, {
        withFileTypes: true,
      });
    } catch {
      dirCovers = [];
    }
    const coverNames = dirCovers.filter((d) => d.isFile()).map((d) => d.name);

    const dbCovers = await Manga.findAll({
      attributes: ["coverPath"],
      raw: true,
    });
    const dbCoverSet = new Set(
      dbCovers
        .map((x) => x.coverPath)
        .filter(Boolean)
        .map(norm),
    );

    const missingCovers = [];

    const pushCoverOnce = (() => {
      const seen = new Set();
      return (full) => {
        if (!full) return;
        const key = norm(full);
        if (seen.has(key)) return;
        seen.add(key);
        missingCovers.push(full);
      };
    })();
    for (const name of coverNames) {
      const full = makeShardedPath(COVER_PATH, name);
      if (!dbCoverSet.has(norm(full))) {
        pushCoverOnce(full);
      }
    }

    // cache for deletion
    lastScan = {
      at: Date.now(),
      idsToDelete,
      missingCovers, // full path
    };

    return {
      totalRows: rows.length,
      missingFileCount: idsToDelete.length,
      missingCoverCount: missingCovers.length,
    };
  }

  // ---- Phase 2: EXECUTE (delete) ----
  // if (!lastScan || !Array.isArray(lastScan.idsToDelete)) {
  //   throw new Error('No scan results available. Run dry run first.');
  // }

  const ids = lastScan.idsToDelete.slice();
  const coversToRemove = lastScan.missingCovers.slice();

  await sequelize.transaction(async (t) => {
    await ensureAttachedTx(sequelize, t, "meta", metadataSqliteFile);

    // 1) delete manga rows (bulk)
    if (ids.length) {
      await Manga.destroy({ where: { id: ids }, transaction: t });
    }

    // 2) prune only orphan Metadata (safe even if multiple Mangas share a hash)
    await sequelize.query(
      `
        DELETE FROM meta.Metadata
        WHERE NOT EXISTS (SELECT 1 FROM main.Mangas m WHERE m.hash = meta.Metadata.hash)
      `,
      { transaction: t },
    );
  });

  // Remove cover files on disk (best-effort, after DB succeeds)
  if (coversToRemove.length) {
    await Promise.allSettled(
      coversToRemove.map((p) => fsp.rm(p, { force: true })),
    );
  }

  // vacuum if requested
  if (vacuum) {
    await Manga.sequelize.query(`VACUUM;`);
    await Metadata.sequelize.query(`VACUUM;`);
  }
  lastScan = null;
  return { ok: true };
});

// tools

ipcMain.handle('set-progress-bar', async (event, progress) => {
  setProgressBar(progress)
})

ipcMain.handle('get-locale', async (event, arg) => {
  return app.getLocale()
})

ipcMain.handle('copy-image-to-clipboard', async (event, filepath) => {
  clipboard.writeImage(nativeImage.createFromPath(filepath))
})

ipcMain.handle('copy-text-to-clipboard', async (event, text) => {
  clipboard.writeText(text)
})

ipcMain.handle('read-text-from-clipboard', async () => {
  return clipboard.readText()
})

ipcMain.handle('update-window-title', async (event, title) => {
  const name = require('./package.json').name
  const version = require('./package.json').version
  if (title) {
    mainWindow.setTitle(name + ' ' + version + ' | ' + title)
  } else {
    mainWindow.setTitle(name + ' ' + version)
  }
})

ipcMain.handle('switch-fullscreen', async (event, arg) => {
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
})

ipcMain.on('get-path-sep', async (event, arg) => {
  event.returnValue = path.sep
})


// 初始化Express
const LANBrowsing = express()
const port = 23786
const sortkey_map = {
  "date_added": {
    key: "date",
    type: "number"
  },
  "date_modified": {
    key: "mtime",
    type: "date"
  },
  "date_posted": {
    key: "posted",
    type: "number"
  },
  "size": {
    key: "bundleSize",
    type: "number"
  },
  "rating": {
    key: "rating",
    type: "number"
  },
  "read_count": {
    key: "readCount",
    type: "number"
  },
  "random": {}
}

// 设置静态文件夹
const staticFilePath = path.resolve(STORE_PATH, 'public')
fs.mkdirSync(staticFilePath, { recursive: true })
LANBrowsing.use('/static', express.static(staticFilePath))

let mangas = []
let tagTranslation = undefined

// sort
function compareItems(a, b, sortKey, ascending = false) {
  const sortConfig = sortkey_map[sortKey]
  if (!sortConfig) {
    throw new Error(`Invalid sort key: ${sortKey}`)
  }

  const { key, type } = sortConfig

  let valA = a[key]
  let valB = b[key]

  if (type === "number") {
    valA = Number(valA) || 0
    valB = Number(valB) || 0
  } else if (type === "date") {
    valA = new Date(valA).getTime() || 0
    valB = new Date(valB).getTime() || 0
  } else {
    valA = String(valA || "")
    valB = String(valB || "")
  }

  if (valA < valB) return ascending ? -1 : 1
  if (valA > valB) return ascending ? 1 : -1
  return 0
}

// 格式化标签
const formatTags = (tags) => {
  return Object.entries(tags)
    .map(([key, values]) => values.map(value => setting.showTranslation ? `${key}:${tagTranslation?.[value]?.name ?? value}` : `${key}:${value}`).join(', '))
    .join(', ')
}

ipcMain.handle('update-tag-translation', async (event, _tagTranslation) => {
  tagTranslation = _tagTranslation
})

LANBrowsing.get('/api/search', async (req, res) => {
  try {
    const filter = req.query.filter || ''
    const start = parseInt(req.query.start, 10) || 0
    const length = parseInt(req.query.length, 10) || 200
    // 默认使用阅读次数排序, 来匹配 mihon 热门不带 sortby
    let sortKey = req.query.sortby || 'read_count'
    let showAll = false
    if (sortKey.includes("_all")) {
      sortKey = sortKey.replace("_all", "")
      showAll = true
    }

    // 读取并搜索数据库
    mangas = await loadBookListFromDatabase()
    let filterMangas
    if (filter) {
      filterMangas = mangas.filter(manga => {
        return JSON.stringify(_.pick(manga, ['title', 'title_jpn', 'status', 'category', 'filepath', 'url'])).toLowerCase().includes(filter.toLowerCase())
        || formatTags(manga.tags).toLowerCase().includes(filter.toLowerCase())
      })
    } else {
      filterMangas = mangas
    }

    if (sortKey !== 'random') {
      filterMangas = filterMangas.sort((a, b) => compareItems(a, b, sortKey))
    } else {
      filterMangas = _.shuffle(filterMangas)
    }
    filterMangas = showAll ? filterMangas : filterMangas.slice(start, start + length)

    // 格式化响应数据
    const responseData = filterMangas.map(manga => ({
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      url: manga.url
    }))
    const hash = createHash('md5').update(JSON.stringify(responseData)).digest('hex')
    res.json({
      data: responseData,
      hash,
      draw: 0,
      recordsFiltered: responseData.length,
      recordsTotal: filterMangas.length
    })
  } catch (error) {
    res.status(500).send(error.message)
  }
})

LANBrowsing.get('/api/search/random', async (req, res) => {
  try {
    // 从数据库中随机获取指定数量的 Manga 记录
    const count = parseInt(req.query.count, 10) || 1
    const randomMangas = _.sampleSize(await loadBookListFromDatabase(), count)

    const responseData = randomMangas.map(manga => ({
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`
    }))

    res.json({
      data: responseData
    })
  } catch (error) {
    console.error('Failed to fetch random Manga:', error)
    res.status(500).send('Internal Server Error')
  }
})

LANBrowsing.get('/api/archives/:hash/metadata', async (req, res) => {
  try {
    const mangaHash = req.params.hash

    // 从数据库找到对应的漫画
    if (_.isEmpty(mangas)) mangas = await loadBookListFromDatabase()
    const manga = await mangas.find(manga => manga.hash === mangaHash)

    if (!manga) {
      return res.status(404).send('Manga not found')
    }

    // 构造响应数据
    const responseMetadata = {
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`
    }

    res.json(responseMetadata)
  } catch (error) {
    res.status(500).send(error.message)
  }
})

// 处理封面图片请求
LANBrowsing.get('/api/archives/:hash/thumbnail', async (req, res) => {
  const hash = req.params.hash
  const manga = await Manga.findOne({where: {hash: hash}})
  if (!manga || !manga.coverPath) {
    return res.status(404).send('Cover not found')
  }
  const coverFilePath = makeShardedPath(staticFilePath, path.basename(manga.coverPath))
  await fs.promises.mkdir(coverFilePath)
  await fs.promises.copyFile(manga.coverPath, coverFilePath)
  if (fs.existsSync(coverFilePath)) {
    res.sendFile(coverFilePath)
  } else {
    res.status(404).send('Cover file not found')
  }
})

let existBook = {
  hash: null,
  imageList: []
}

// 处理章节列表请求
LANBrowsing.get('/api/archives/:hash/files', async (req, res) => {
  try {
    const mangaHash = req.params.hash

    // 从数据库找到对应的漫画
    const manga = await Manga.findOne({where: {hash: mangaHash}})

    if (!manga) {
      return res.status(404).send('Manga not found')
    }

    await clearFolder(VIEWER_PATH)
    await clearFolder(staticFilePath)
    const imageList = await getImageListByBook(manga.filepath, manga.type)

    existBook = {
      hash: manga.hash,
      imageList: imageList.map(p => p.absolutePath)
    }
    // 构造响应数据
    const responseFiles = {
      job: Date.now(), // 示例中的 job 可以是一个随机数或时间戳
      pages: imageList.map((file, index) => `/api/archives/${manga.hash}/page?path=${index + 1}`)
    }

    res.json(responseFiles)
  } catch (error) {
    res.status(500).send(error.message)
  }
})

// 处理章节图片请求
LANBrowsing.get('/api/archives/:hash/page', async (req, res) => {
  const hash = req.params.hash
  const page = parseInt(req.query.path, 10)
  if (isNaN(page) || page < 1) {
    return res.status(400).send('Invalid page number')
  }

  const manga = await Manga.findOne({where: {hash: hash}})
  if (!manga || !manga.filepath) {
    return res.status(404).send('File not found')
  }

  // 获取章节图片列表
  try {
    let imageList
    if (manga.hash === existBook.hash) {
      imageList = existBook.imageList
    } else {
      await clearFolder(VIEWER_PATH)
      await clearFolder(staticFilePath)
      imageList = await getImageListByBook(manga.filepath, manga.type)
      imageList = imageList.map(p => p.absolutePath)
      existBook.hash = manga.hash
      existBook.imageList = imageList
    }
    const imageFilePath = imageList[page - 1]
    if (!imageFilePath) {
      return res.status(404).send('Image not found')
    }

    // 重命名并复制图片文件到静态文件夹
    const imageFileName = `${manga.hash}_${page}${path.extname(imageFilePath)}`
    const imageFile = path.join(staticFilePath, imageFileName)
    await fs.promises.copyFile(imageFilePath, imageFile)

    // 发送图片文件
    if (fs.existsSync(imageFile)) {
      res.sendFile(imageFile)
    } else {
      res.status(404).send('Image file not found')
    }
  } catch (err) {
    console.error(err)
    res.status(500).send('Error processing file')
  }
})

// 处理webview请求
LANBrowsing.get('/reader', async (req, res) => {
  const id = req.query.id
  const manga = await Manga.findOne({ where: { hash: id } })

  // 重定向至manga.url
  if (manga && manga.url) {
    res.redirect(manga.url.replace('exhentai', 'e-hentai'))
  } else {
    res.status(404).send('Manga not found')
  }
})

LANBrowsing.get('/', (req, res) => {
  switch (setting.language) {
    case 'en-US':
      res.redirect('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/LAN-Browsing')
      break
    case 'zh-CN':
    case 'zh-TW':
    default:
      res.redirect('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/%E5%B1%80%E5%9F%9F%E7%BD%91%E6%B5%8F%E8%A7%88')
      break
  }
})

let LANBrowsingInstance
// 启动Express服务器
const enableLANBrowsing = () => {
  if (LANBrowsingInstance?.listening) {
    LANBrowsingInstance.close(() => {
      LANBrowsingInstance = LANBrowsing.listen(port, '0.0.0.0', () => {
        sendMessageToWebContents(`LAN browsing restart and listening at http://0.0.0.0:${port}`)
      })
    })
  } else {
    LANBrowsingInstance = LANBrowsing.listen(port, '0.0.0.0', () => {
      sendMessageToWebContents(`LAN browsing listening at http://0.0.0.0:${port}`)
    })
  }
}

ipcMain.handle('enable-LAN-browsing', async (event, arg) => {
  enableLANBrowsing()
})



/*  ===== for sub browser in the search page  =====
* Use the WebContentsView API to embed a web page in the main browser
*  in SearchDialog.vue
* */

// Track WebContentsView instances by id (e.g., "search-dialog")
const wcvById = new Map()
function resolveHostWindow(sender) {
  const bySender = BrowserWindow.fromWebContents(sender)
  if (bySender) return bySender
  return BrowserWindow.getFocusedWindow() || null
}

function ensureView(host, id, opts) {
  const existing = wcvById.get(id)
  if (existing && existing.view && !existing.view.webContents.isDestroyed()) {
    if (existing.host !== host) {
      try { existing.host.contentView.removeChildView(existing.view) } catch {}
      host.contentView.addChildView(existing.view)
      existing.host = host
    }
    return existing.view
  }

  const ses = opts && opts.partition
    ? session.fromPartition(opts.partition)
    : host.webContents.session

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(opts && opts.webPreferences ? opts.webPreferences : {}),
    },
  })

  if (opts && opts.userAgent) {
    try { view.webContents.setUserAgent(opts.userAgent) } catch {}
  }

  host.contentView.addChildView(view)
  return view
}

// send the current url to the url bar in SearchDialogBrowser.vue
function pushNavState(rec, url) {
  const wc = rec.view.webContents
  const nh = wc.navigationHistory
  const target = rec.target
  if (!target || target.isDestroyed()) return
  target.send('wcv:nav-state', {
    id: rec.id,
    url: url ?? wc.getURL(),
    canBack: nh?.canGoBack?.() ?? wc.canGoBack?.(),
    canFwd:  nh?.canGoForward?.() ?? wc.canGoForward?.(),
  })
}

function wireNavigationForwarders(rec) {
  const wc = rec.view.webContents
  const onDidNavigate       = (_ev, url) => pushNavState(rec, url)
  const onDidNavigateInPage = (_ev, url) => pushNavState(rec, url)
  const onStart             = () => pushNavState(rec)
  const onStop              = () => pushNavState(rec)
  const onFail              = () => pushNavState(rec)

  wc.on('did-navigate', onDidNavigate)
  wc.on('did-navigate-in-page', onDidNavigateInPage)
  wc.on('did-start-navigation', onStart)
  wc.on('did-stop-loading', onStop)
  wc.on('did-fail-load', onFail)

  rec._unsubNav = () => {
    wc.removeListener('did-navigate', onDidNavigate)
    wc.removeListener('did-navigate-in-page', onDidNavigateInPage)
    wc.removeListener('did-start-navigation', onStart)
    wc.removeListener('did-stop-loading', onStop)
    wc.removeListener('did-fail-load', onFail)
  }

  // Initial state so buttons are correct right after attach
  pushNavState(rec)
}

// end of navigation shortcuts

function teardownViewsForHost(host) {
  for (const [id, rec] of wcvById) {
    if (rec.host === host) {
      try { rec._unsubNav && rec._unsubNav() } catch {}
      try { rec.host.contentView.removeChildView(rec.view) } catch {}
      try { rec.view.webContents.destroy() } catch {}
      wcvById.delete(id)
    }
  }
}

app.on('browser-window-created', (_e, win) => {
  win.on('closed', () => teardownViewsForHost(win))
})


// ==================== IPCs ====================

ipcMain.handle('wcv:attach', async (evt, payload) => {
  // payload: { id, bounds: {x,y,width,height}, partition?, userAgent?, url?, }
  const host = resolveHostWindow(evt.sender)
  if (!host) return { ok: false, error: 'No host window' }

  const view = ensureView(host, payload.id, {
    partition: payload.partition,
    userAgent: payload.userAgent,
  })

  try { view.setBounds(payload.bounds) } catch {}

  const rec = {
    id: payload.id,
    host,
    view,
    target: evt.sender,
    _unsubNav: null,
  }
  wcvById.set(payload.id, rec)
  // update the url bar when navigation happens
  wireNavigationForwarders(rec)

  if (payload.url) {
    try { await view.webContents.loadURL(payload.url)
    }  catch {
      console.warn('failed to loadURL', payload.url)
    }
  }

  return { ok: true }
})

ipcMain.handle('wcv:set-bounds', (_evt, payload) => {
  // payload: { id, bounds: {x,y,width,height} }
  const rec = wcvById.get(payload.id)
  if (!rec) return { ok: false, error: 'No view' }
  try {
    rec.view.setBounds(payload.bounds)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
})

ipcMain.handle('wcv:loadURL', async (_evt, payload) => {
  // payload: { id, url }
  const rec = wcvById.get(payload.id)
  if (!rec) return { ok: false, error: 'No view' }
  try {
    await rec.view.webContents.loadURL(payload.url)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
})

ipcMain.handle('wcv:detach', (_evt, id) => {
  const rec = wcvById.get(id)
  if (!rec) return { ok: true }
  try { rec._unsubNav && rec._unsubNav() } catch {}
  try { rec.host.contentView.removeChildView(rec.view) } catch {}
  try { rec.view.webContents.destroy() } catch {}
  wcvById.delete(id)
  return { ok: true }
})


ipcMain.handle('wcv:getState', (_e, id) => {
  const rec = wcvById.get(id); if (!rec) return null
  const wc = rec.view.webContents
  const nh = wc.navigationHistory
  return {
    id,
    url: wc.getURL(),
    canBack: nh?.canGoBack?.() ?? wc.canGoBack?.(),
    canFwd:  nh?.canGoForward?.() ?? wc.canGoForward?.(),
  }
})

ipcMain.handle('wcv:nav', (_e, { id, dir }) => {
  const rec = wcvById.get(id); if (!rec) return { ok: false, reason: 'not-found' }
  const wc = rec.view.webContents
  const nh = wc.navigationHistory
  try {
    if (dir === 'back')    (nh?.canGoBack?.()    ? nh.goBack()    : wc.goBack?.())
    if (dir === 'forward') (nh?.canGoForward?.() ? nh.goForward() : wc.goForward?.())
  } catch (e) { return { ok: false, error: String(e) } }
  // optionally push fresh state immediately
  pushNavState(rec)
  return { ok: true }
})

// use the same session to load the html for scraping
ipcMain.handle("searchSessionFetchUrl", async (_e, { url, wcId }) => {
  /** Grab the network response body via Chrome DevTools Protocol (CDP) instead of serializing the DOM.
   * If it fails, fall back to rendered DOM.
   * */
  const rec = wcvById.get(wcId);
  if (!rec) throw new Error(`view not found for wcId=${wcId}`);
  const wc = rec.view.webContents;

  const target = url.trim();
  const sameUrl = wc.getURL() === target;

  const dbg = wc.debugger;
  let attachedHere = false;

  try {
    if (!dbg.isAttached()) {
      dbg.attach("1.3"); // attach Chrome DevTools Protocol (CDP)
      attachedHere = true;
    }
    await dbg.sendCommand("Network.enable");

    let docRequestId = null;

    // Listen for the main-document request of this navigation/reload
    const onMessage = (event, method, params) => {
      if (method === "Network.requestWillBeSent") {
        // We only care about the main Document request
        if (params.type === "Document") {
          // Match the target URL if navigating; if reloading same URL, accept it
          const reqUrl = params.request?.url || params.documentURL;
          if (!target || reqUrl === target || sameUrl) {
            docRequestId = params.requestId;
          }
        }
      }
    };

    dbg.on("message", onMessage);

    // Trigger a network fetch of the main document
    if (!sameUrl) {
      await wc.loadURL(target);
    } else {
      // Force a quick reload to generate a fresh Document request we can capture
      wc.reloadIgnoringCache();
    }

    // Wait for the response body of that main document
    const body = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out capturing response body"));
      }, 12000);

      const onFinish = async (event, method, params) => {
        if (method !== "Network.loadingFinished") return;
        if (!docRequestId || params.requestId !== docRequestId) return;

        try {
          const resp = await dbg.sendCommand("Network.getResponseBody", {
            requestId: docRequestId,
          });
          cleanup();
          const text = resp.base64Encoded
            ? Buffer.from(resp.body, "base64").toString("utf8")
            : resp.body;
          resolve(text);
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        dbg.removeListener("message", onFinish);
        dbg.removeListener("message", onMessage);
      };

      dbg.on("message", onFinish);
    });

    return body; // <-- original response text (doctype included)
  } catch (err) {
    // Fallback: rendered DOM (works for SPAs or if CDP failed)
    try {
      await wc.executeJavaScript(`
                new Promise((resolve) => {
                  if (document.readyState !== 'loading') { resolve(); }
                  else { document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }); }
                })
              `);
      return await wc.executeJavaScript('document.body?.innerHTML ?? ""');
    } catch (e) {
      sendMessageToWebContents("searchSessionFetchUrl fallback failed:", e);
    }
  } finally {
    try {
      if (attachedHere && dbg.isAttached()) {
        await dbg.sendCommand("Network.disable");
        dbg.detach();
      }
    } catch {}
  }
});

/** ------------------------------------------------------------------
 *    save files
 *    ------------------------------------------------------------------
 *    */

ipcMain.handle("save-file", async (_e, { dirname, filename, content }) => {
  // called in FolderTreeView.vue to save the translation file
  const dir = path.join(app.getPath("userData"), dirname);
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.promises.writeFile(filePath, content, "utf8");
  return filePath;
});



/** ------------------------------------------------------------------
 *            Cache related functions
 *  ------------------------------------------------------------------
 *  used to load cache upon app mounted, and save cache after every library scan
 * */
const MAGIC = Buffer.from('MMCACHE1');      // 8 bytes
const HEADER_SIZE = 72;                     // bytes
const CACHE_FORMAT_VERSION = 1;             // bump if structure changes
const CACHE_PATH = path.join(STORE_PATH, 'cache', 'appCache.snap');
const BROTLI_Quality = 5
/**
 * Save bookList to cache
 * @param {Array|Object} data
 */
async function saveAppCache(data, ){
    const dbSignature = {
    MangaDbSig: await readDbSignatureSequelize(Manga.sequelize),
    MetadataDbSig: await readDbSignatureSequelize(Metadata.sequelize),
  }

  const container = {
    meta: {
      cacheFormatVersion: CACHE_FORMAT_VERSION,
      createdAtMs: Date.now(),
    },
    dbSignature:dbSignature,
    data:data,
  };


  // 1) serialize (MessagePack)
  const raw = pack(container); // Buffer
  const uncompressedSize = raw.length;

  // 2) compress (Brotli)
  const compressed = zlib.brotliCompressSync(raw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_Quality }
  });

  // 3) header
  const header = buildHeader({
    version: CACHE_FORMAT_VERSION,
    createdAtMs: Date.now(),
    uncompressedSize,
    compressedPayload: compressed
  });

  // 4) concat and atomically write
  await atomicWrite(CACHE_PATH, Buffer.concat([header, compressed]));
}


ipcMain.handle("save-app-cache", async (_e, data, opts = {}) => {
  await saveAppCache(data, opts);
})


/**
 * Load bookList from cache
 * @param {object} [opts]
 * @param {number} [opts.expectFormatVersion] - if set and mismatched -> throw
 * @returns {{meta: object, bookList: any}}
 */
ipcMain.handle("load-app-cache", async (_e, opts = {}) => {
  const buf = await fsp.readFile(CACHE_PATH);
  const hdr = verifyHeaderAndChecksum(buf);
  if (
    opts.expectFormatVersion != null &&
    hdr.version !== opts.expectFormatVersion
  ) {
    throw new Error(
      `Cache format mismatch: got ${hdr.version}, need ${opts.expectFormatVersion}`,
    );
  }

  const raw = zlib.brotliDecompressSync(buf.subarray(HEADER_SIZE));

  if (hdr.uncompressedSize && hdr.uncompressedSize !== raw.length) {
    throw new Error(`Cache version mismatch`);
  }

  const container = unpack(raw);
  if (!container || typeof container !== 'object' || !container.meta) {
    throw new Error('Cache payload missing meta');
  }
  return { meta: container.meta, appCache: container.data, dbSignature: container.dbSignature };

})
ipcMain.handle("should-use-cache", async (_e, dbSig) => {
  if(!dbSig) return false
  // get db signature
  const MangaDbSig = await readDbSignatureSequelize(Manga.sequelize)
  const MetadataDbSig = await readDbSignatureSequelize(Metadata.sequelize)
  return signaturesMatch(dbSig.MangaDbSig, MangaDbSig) && signaturesMatch(dbSig.MetadataDbSig, MetadataDbSig)
})

// live mirror cache update, used to save cache app.on('before-quit')
let latestAppCache = null
ipcMain.on('cache:update', (_e, appCache) => {
  latestAppCache = appCache
})

// helpers
async function readDbSignatureSequelize(sequelize) {
  // expects a meta table with rows: ('rev', INTEGER), ('last_change_epoch_ms', INTEGER)
  const [revRow] = await sequelize.query(
    "SELECT CAST(value AS INTEGER) AS rev FROM meta WHERE key='rev' LIMIT 1;",
    { type: sequelize.QueryTypes.SELECT }
  );
  const [sv] = await sequelize.query("PRAGMA schema_version;", { type: sequelize.QueryTypes.SELECT });
  const [uv] = await sequelize.query("PRAGMA user_version;",   { type: sequelize.QueryTypes.SELECT });

  return {
    rev: Number(revRow?.rev || 0),
    schema_version: Number(sv?.schema_version || 0),
    user_version: Number(uv?.user_version || 0),
  };
}

function signaturesMatch(cached, live) {
  return (
    Number(cached?.rev) === Number(live?.rev) &&
    Number(cached?.schema_version) === Number(live?.schema_version) &&
    Number(cached?.user_version) === Number(live?.user_version)
  );
}


function u64ToBufLE(n) {
  // n can be up to Number.MAX_SAFE_INTEGER
  const b = Buffer.allocUnsafe(8);
  let lo = n >>> 0;
  let hi = Math.floor(n / 2 ** 32) >>> 0;
  b.writeUInt32LE(lo, 0);
  b.writeUInt32LE(hi, 4);
  return b;
}

function bufToU64LE(b, off) {
  const lo = b.readUInt32LE(off);
  const hi = b.readUInt32LE(off + 4);
  return hi * 2 ** 32 + lo;
}

/**
 * Atomically write a cache file: <file>.tmp -> fsync -> rename
 */
async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `${path.basename(filePath)}.tmp`);
  await fsp.mkdir(dir, { recursive: true });
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();                 // fsync file
  } finally {
    await fh.close();
  }
  // fsync directory to ensure rename durability (best effort)
  try {
    const dh = await fsp.opendir(dir);
    // Node doesn't expose fsync on dir via promises; best effort by stat
    await fsp.stat(dir);
    await dh.close();
  } catch {}
  await fsp.rename(tmp, filePath);
}

/**
 * Build a header for the compressed payload buffer
 */
function buildHeader({ version, createdAtMs, uncompressedSize, compressedPayload }) {
  const header = Buffer.alloc(HEADER_SIZE);

  // magic
  MAGIC.copy(header, 0);
  // version, flags
  header.writeUInt32LE(version >>> 0, 8);
  header.writeUInt32LE(0, 12);
  // createdAtMs
  u64ToBufLE(createdAtMs).copy(header, 16);
  // sizes
  u64ToBufLE(uncompressedSize).copy(header, 24);
  u64ToBufLE(compressedPayload.length).copy(header, 32);
  // checksum of compressed payload (SHA-256)
  const sha = createHash('sha256').update(compressedPayload).digest();
  sha.copy(header, 40);
  return header;
}

function verifyHeaderAndChecksum(buf) {
  if (buf.length < HEADER_SIZE) throw new Error('Cache header too small');
  const header = buf.subarray(0, HEADER_SIZE);
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Bad cache magic');
  const version           = header.readUInt32LE(8);
  const flags             = header.readUInt32LE(12);
  const createdAtMs       = bufToU64LE(header, 16);
  const uncompressedSize  = bufToU64LE(header, 24);
  const compressedSize    = bufToU64LE(header, 32);
  const shaExpected       = header.subarray(40, 72);

  if (buf.length !== HEADER_SIZE + compressedSize) throw new Error('Cache truncated/extra bytes');

  const payload = buf.subarray(HEADER_SIZE);
  const shaActual = createHash('sha256').update(payload).digest();
  if (!shaActual.equals(shaExpected)) throw new Error('Cache checksum mismatch');

  return { version, flags, createdAtMs, uncompressedSize, compressedSize };
}
