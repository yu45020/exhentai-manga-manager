const { app, BrowserWindow, ipcMain, session, dialog, shell, screen, Menu, clipboard, nativeImage, Tray, webContents, WebContentsView } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const fsp = fs.promises
const { brotliDecompress } = require('zlib')
const { promisify, format } = require('util')
const _ = require('lodash')
const { nanoid } = require('nanoid')
const sharp = require('sharp')
const { exec } = require('child_process')
const { createHash } = require('crypto')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')
const windowStateKeeper = require('electron-window-state')
const express = require('express')
const { performance } = require('node:perf_hooks')
const { prepareMangaModel, prepareMetadataModel } = require('./modules/database')
const { prepareTemplate } = require('./modules/prepare_menu.js')
const { getBookFilelist, geneCover, geneCoverFromBuffer, getImageListByBook, deleteImageFromBook } = require('./fileLoader/index.js')
const { STORE_PATH, isPortable, TEMP_PATH, COVER_PATH, VIEWER_PATH, prepareSetting, prepareCollectionList, preparePath } = require('./modules/init_folder_setting.js')
const { findSameFile } = require('./fileLoader/folder.js')
const { ElectronBlocker } = require('@ghostery/adblocker-electron')
const { QueryTypes } = require("sequelize");

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
  
  await Manga.sequelize.query(`CREATE INDEX IF NOT EXISTS manga_hash_index ON Mangas(hash)`)
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
    if (cmd === 'browser-backward' && target.canGoBack?.()) {
      target.goBack()
    } else if (cmd === 'browser-forward' && target.canGoForward?.()) {
      target.goForward()
    }
  })
  return win
}

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=65536')
// app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const blocker = await ElectronBlocker.fromLists(fetch, [
    'https://easylist.to/easylist/easylist.txt',
    'https://easylist.to/easylist/easyprivacy.txt',
  ], { enableCompression: true })
  // partition name must be same as the webview partition
  blocker.enableBlockingInSession(session.fromPartition('persist:eh-search'))

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
  const tTotal0 = performance.now();
  
  // If DB is empty, seed from legacy source first (same behavior as before)
  const count = await Manga.count();
  if (count === 0) {
    const legacy = await loadLegecyBookListFromFile();
    if (legacy?.length) await saveBookListToDatabase(legacy);
  }


  const bookList =  await Manga.sequelize.transaction(async (t) => {
    // Attach the metadata DB (if not already)
    await ensureAttachedTx(Manga.sequelize, t, 'meta', metadataSqliteFile)
    // upsert metadata table from the mangas table
    await Manga.sequelize.query(`
      INSERT INTO meta.Metadata (
        hash, title, status, rating, tags, title_jpn, filecount, posted, filesize,
        category, url, mark, createdAt, updatedAt
      )
      SELECT 
        m.hash, m.title, m.status, m.rating, m.tags, m.title_jpn, m.filecount, m.posted, m.filesize,
        m.category, m.url, m.mark,  m.createdAt, m.updatedAt
      FROM main.Mangas AS m
      --- the hash column in the Mangas table is not unique, so we pick the earliest row
      WHERE NOT EXISTS (SELECT 1 FROM meta.Metadata AS md WHERE md.hash = m.hash)
        AND m.rowid = (
          SELECT MIN(m2.rowid) FROM main.Mangas m2 WHERE m2.hash = m.hash
        );
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
  sendMessageToWebContents(`loadBookListFromDatabase Completed in : ${totalS.toFixed(2)} s`);;
  for (let i = 0; i < bookList.length; i++) {
    const b = bookList[i];
    b.tags = JSON.parse(b.tags || '{}');
  }
  return bookList;
};

const _loadBookListFromDatabase = async () => {
  const tTotal0 = performance.now();
  let bookList = await Manga.findAll()
  bookList = bookList.map(b => b.toJSON())
  if (_.isEmpty(bookList)) {
    bookList = await loadLegecyBookListFromFile()
    await saveBookListToDatabase(bookList)
  }
  let metadataList = await Metadata.findAll()
  metadataList = metadataList.map(m => m.toJSON())
  const bookListLength = bookList.length
  for (let i = 0; i < bookListLength; i++) {
    const book = bookList[i]
    const findMetadata = metadataList.find(m => m.hash === book.hash)
    if (findMetadata) {
      if (book.status === 'non-tag' && findMetadata.status !== 'non-tag') await Manga.update(findMetadata, { where: { id: book.id } })
      Object.assign(book, findMetadata)
    } else {
      setProgressBar((i + 1) / bookListLength)
      await Metadata.upsert(book)
    }
  }
  setProgressBar(-1)
  const totalS = (performance.now() - tTotal0) / 1000;
  sendMessageToWebContents(`Load Books from DB Completed in : ${totalS.toFixed(2)} s`);;
  return bookList
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

// Async (streaming) file hash to avoid fs.readFileSync blocking the event loop
function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const s = fs.createReadStream(filePath)
    s.on('data', (chunk) => hash.update(chunk))
    s.on('error', reject)
    s.on('end', () => resolve(hash.digest('hex')))
  })
}

//  generate cover &  hash the target file
// async function coverAndHash(filepath, type) {
//   const { targetFilePath, coverPath, pageCount, bundleSize, mtime, coverHash } =
//       await geneCover(filepath, type)
//   let hash = null
//   if (targetFilePath && coverPath) hash = await sha1File(targetFilePath)
//   return { coverPath, pageCount, bundleSize, mtime, coverHash, hash }
// }

async function coverAndHashInMem(filepath, type) {
  const { hash, coverPath, pageCount, bundleSize, mtime, coverHash, coverSharp } = await geneCoverFromBuffer(filepath, type)
  return { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp }
}

// ----- additional helpers
async function scanLibraryFilesWithExclude() {
  let list = await getBookFilelist(setting.library)
  if (!_.isEmpty(setting.excludeFile)) {
    try {
      const excludeRe = new RegExp(setting.excludeFile)
      list = _.filter(list, file => !excludeRe.test(file.filepath))
    } catch {
      console.log('Illegal regular expressions')
    }
  }
  return list
}


function computeWorkConcurrency(maxCpu = 4) {
  // At least 2 and at most 6; or tune for SMR HDD ?
  const cpu = Math.max(1, os.cpus()?.length || 1)
  const workConcurrency = Math.min(Math.max(2, cpu - 2), maxCpu)
  return { cpu, workConcurrency }
}

// main function
ipcMain.handle('load-book-list', async (event, scan) => {
  if (scan) {
    sendMessageToWebContents('Start loading library')

    const bookList = await Manga.findAll({ raw: true })
    bookList.forEach(b => b.exist = false)
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
    const { workConcurrency } = computeWorkConcurrency(4)
    const workLimit = createLimiter(workConcurrency)
    const dbLimit = createLimiter(1)
    const coverLimit = createLimiter(Math.min(workConcurrency, 2)) // avoid HDD IO spike
    // thumbnail size is 50KB, and assume each of the other 2 temp files are less than 2MB (avg over 30K files)
    // around 2 GB of temp files if they are all written in disk; but most of them are in RAM
    const BATCH_SIZE = 100
    let processed = 0

    for (let offset = 0; offset < listLength; offset += BATCH_SIZE) {
      const chunk = list.slice(offset, Math.min(offset + BATCH_SIZE, listLength))
      const chunkTasks = chunk.map(({ filepath, type }, j) =>
          workLimit(async () => {
            const globalIdx = offset + j
            try {
              // Path already known
              let found = byFilepath.get(filepath)
              if (found) {
                found.exist = true
                if (isPortable) {
                  const newCoverPath = path.join(COVER_PATH, path.basename(found.coverPath))
                  if (found.coverPath !== newCoverPath) {
                    found.coverPath = newCoverPath
                    await dbLimit(() =>
                        Manga.update({ coverPath: newCoverPath }, { where: { id: found.id } })
                    )
                  }
                }
                return
              }

              // Relocated-only?
              const existingManga = await findSameFile(filepath, type, Manga)
              if (existingManga) {
                const prev = byId.get(existingManga.id) || null
                if (prev) {
                  prev.exist = true
                  const newCoverPath = path.join(COVER_PATH, path.basename(prev.coverPath))
                  prev.coverPath = newCoverPath
                  prev.filepath = filepath
                  byFilepath.set(filepath, prev)
                  await dbLimit(() =>
                      Manga.update(
                          { filepath, coverPath: newCoverPath },
                          { where: { id: existingManga.id } }
                      )
                  )
                }
                return
              }

              // Brand-new file: run the atomic op (cover -> hash -> temp cleanup)
              const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } =
                  await coverAndHashInMem(filepath, type)

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

                await coverLimit(() => coverSharp.toFile(coverPath))

                await dbLimit(() => Manga.create(newBook))
                bookList.push(newBook)
                byFilepath.set(filepath, newBook)
                byId.set(id, newBook)
              }
            } catch (e) {
              sendMessageToWebContents(
                  `Load ${filepath} failed because ${e?.message || e}, ${globalIdx + 1} of ${listLength}`
              )
            }
          })
      )

      await Promise.all(chunkTasks)
      processed += chunk.length
      setProgressBar(processed / listLength)
      try {
        await clearFolder(TEMP_PATH)
      } catch {
      }
    }
    
    setProgressBar(-1)
    const totalS = (performance.now() - tTotal0) / 1000;
    sendMessageToWebContents(`Completed in : ${totalS.toFixed(2)} s`);;
  }
  return await loadBookListFromDatabase()
})

ipcMain.handle('force-gene-book-list', async (event, arg) => {
  await Manga.destroy({ truncate: true })
  await Manga.sequelize.query(`DROP INDEX IF EXISTS manga_hash_index`)

  await clearFolder(TEMP_PATH)
  await clearFolder(COVER_PATH)
  sendMessageToWebContents('Start loading library')

  const list = await scanLibraryFilesWithExclude()
  const listLength = list.length
  sendMessageToWebContents(`Load ${listLength} book from library`)

  if (listLength === 0) {
    setProgressBar(-1)
    return await loadBookListFromDatabase()
  }

  const tTotal0 = performance.now()
  const { workConcurrency } = computeWorkConcurrency(4)
  const workLimit = createLimiter(workConcurrency)
  const dbLimit = createLimiter(1) // serialize writes for SQLite
  const coverLimit = createLimiter(Math.min(workConcurrency, 2)) // avoid HDD IO spike
  const BATCH_SIZE = 100
  let processed = 0


  for (let offset = 0; offset < listLength; offset += BATCH_SIZE) {
    const chunk = list.slice(offset, Math.min(offset + BATCH_SIZE, listLength))

    const tasks = chunk.map(({ filepath, type }, j) =>
        workLimit(async () => {
          const globalIdx = offset + j
          try {
            // Always rebuild cover + hash
            const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } =
                await coverAndHashInMem(filepath, type)

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

              await coverLimit(() => coverSharp.toFile(coverPath))
              await dbLimit(() => Manga.create(newBook))
            }
          } catch (e) {
            sendMessageToWebContents(
                `Rebuild ${filepath} failed because ${e?.message || e}, ${globalIdx + 1} of ${listLength}`
            )
          }
        })
    )

    await Promise.all(tasks)

    processed += chunk.length
    setProgressBar(processed / listLength)

    // Batch cleanup to keep disk quiet
    try {
      await clearFolder(TEMP_PATH)
    } catch {}
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
ipcMain.handle('get-folder-tree', async (event, bookList) => {
  const folderList = [...new Set(bookList.map(b => path.dirname(b.filepath)))]
  const librarySplitPathsLength = setting.library.split(path.sep).length - 1
  const bookPathSplitList = folderList.sort().map(fp => fp.split(path.sep).slice(librarySplitPathsLength))
  const folderTreeObject = {}
  for (const folders of bookPathSplitList) {
    _.set(folderTreeObject, folders.map(f => '_' + f), {})
  }
  const resolveTree = (preRoot, tree, initFolder) => {
    _.forIn(tree, (node, label) => {
      const trueLabel = label.slice(1)
      if (_.isEmpty(node)) {
        preRoot.push({
          label: trueLabel,
          value: trueLabel,
          folderPath: [...initFolder, trueLabel].slice(1).join(path.sep),
        })
      } else {
        preRoot.push({
          label: trueLabel,
          value: trueLabel,
          folderPath: [...initFolder, trueLabel].slice(1).join(path.sep),
          children: resolveTree([], node, [...initFolder, trueLabel]),
        })
      }
    })
    return preRoot
  }
  return resolveTree([], folderTreeObject, [])
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

ipcMain.handle('use-new-cover', async (event, filepath) => {
  const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(filepath))
  const coverPath = path.join(COVER_PATH, nanoid() + path.extname(filepath))
  try {
    await fs.promises.copyFile(filepath, copyTempCoverPath)
    await sharp(copyTempCoverPath, { failOnError: false })
    .resize(500, 707, {
      fit: 'contain',
      background: '#303133'
    })
    .toFile(coverPath)
    return coverPath
  } catch (e) {
    sendMessageToWebContents(`Generate cover from ${filepath} failed because ${e}`)
  }
})

ipcMain.handle('open-local-book', async (event, filepath) => {
  exec(`${setting.imageExplorer} "${filepath}"`)
})

ipcMain.handle('delete-local-book', async (event, filepath) => {
  if (filepath.startsWith(setting.library)) {
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
  }
})

ipcMain.handle('move-local-book', async (event, oldPath, folderArr) => {
  try {
    const pathSep = require('path').sep
    const folderPath = Array.isArray(folderArr) && folderArr.length > 0 ? folderArr.join(pathSep) : ''
    const newFilePath = path.join(path.dirname(setting.library), folderPath, path.basename(oldPath))
    if (oldPath !== newFilePath) {
      await fs.promises.rename(oldPath, newFilePath)
      sendMessageToWebContents(`Move ${oldPath} to ${newFilePath} successfully`)
      return newFilePath
    } else {
      sendMessageToWebContents(`Move ${oldPath} failed because the new path is the same as the old path`)
      return false
    }
  } catch (e) {
    sendMessageToWebContents(`Move ${oldPath} failed because ${e}`)
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

ipcMain.handle('save-setting', async (event, receiveSetting) => {
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
  setting = receiveSetting
  if (tray && !setting.minimizeToTray) {
    tray.destroy()
    tray = null
  }
  return await fs.promises.writeFile(path.join(STORE_PATH, 'setting.json'), JSON.stringify(setting, null, '  '), { encoding: 'utf-8' })
})

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

ipcMain.handle('import-sqlite', async (event, bookList) => {
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
    if (!sequelize) return null

    // page_size / page_count / freelist_count are per-DB
    const [[psRow]]  = await sequelize.query('PRAGMA page_size')
    const [[pcRow]]  = await sequelize.query('PRAGMA page_count')
    const [[flRow]]  = await sequelize.query('PRAGMA freelist_count')

    const pageSize = asNum(psRow.page_size ?? psRow.PAGE_SIZE ?? psRow[Object.keys(psRow)[0]], 4096)
    const pageCnt  = asNum(pcRow.page_count ?? pcRow.PAGE_COUNT ?? pcRow[Object.keys(pcRow)[0]], 0)
    const freeCnt  = asNum(flRow.freelist_count ?? flRow.FREELIST_COUNT ?? flRow[Object.keys(flRow)[0]], 0)

    const usedBytes = pageCnt * pageSize
    const freeBytes = freeCnt * pageSize
    return {
      freeMB: +(freeBytes / (1024 * 1024)).toFixed(1),
      freeRatio: usedBytes ? +(freeBytes / usedBytes).toFixed(3) : 0,
    }
  }

  const main  = await getVacuumStats(Manga.sequelize).catch(() => null)
  const meta  = await getVacuumStats(Metadata.sequelize).catch(() => null)
  return { main, meta  }
})

let lastScan = null;
ipcMain.handle('remove-missing-records', async (event,arg = {}) => {
    /** find files from the Mangas table that are missing on disk
     *  remove their covers and rows from Mangas and Metadata tables
     *  Dry run first to get counts, then confirm to actually delete
     * */
    // -- helpers to check cover & file path
    function withTrail(p) {
        return p.endsWith('/') ? p : p + '/';
    }
    function isInsideLibrary(filePath, libraryRoot) {
      if (!filePath || !libraryRoot) return false;
      const fp = norm(filePath);
      const root = withTrail(norm(libraryRoot));
      return fp.startsWith(root);
    }
    async function isMissingItem(p) {
      const RE_IMAGE = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i;
      if (!p) return true;
      if (!isInsideLibrary(p, setting.library)) return true // remove if outside managed library

      try {
        const st = await fsp.stat(p);
        if (st.isFile()) return false;                // archive or single file present
        if (st.isDirectory()) {
          const entries = await fsp.readdir(p);
          // consider present only if at least one image file exists
          return !entries.some(name => RE_IMAGE.test(name));
        }
        // neither file nor directory (e.g., special) -> treat as missing
        return true;
      } catch {
        // stat/readdir failed -> missing
        return true;
      }
    }
    function norm(p) {
      if (!p) return '';
      const normalized = path.normalize(p).replace(/\\/g, '/');
      // 3) Windows is case-insensitive; compare in lowercase there
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    const { confirm, vacuum } = arg;
    const sequelize = Manga.sequelize

    // ---- Phase 1: DRY RUN (scan + counts) ----
    if (!confirm) {
    // Grab what we need from Mangas
    const [rows] = await sequelize.query(` SELECT id, hash, filepath, coverPath FROM Mangas `, { raw: true });

    const idsToDelete = [];
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

    for (const r of rows) {
      const missing = await isMissingItem(r.filepath);
      if (missing) {
        idsToDelete.push(r.id);
        if (r.coverPath) pushCoverOnce(r.coverPath);
      }
    }
    // check all covers in disk that are not referenced in Mangas
    let dirCovers = [];
    try{
      dirCovers = await fs.promises.readdir(COVER_PATH, { withFileTypes: true });
    }catch{
      dirCovers = []
    }
    const coverNames = dirCovers.filter(d => d.isFile()).map(d => d.name);

    const dbCovers = await Manga.findAll({ attributes: ['coverPath'], raw: true });
    const dbCoverSet = new Set(
      dbCovers.map(x => x.coverPath).filter(Boolean).map(norm)
    );

    for (const name of coverNames) {
      const full = path.join(COVER_PATH, name);
      if (!dbCoverSet.has(norm(full))) {
        pushCoverOnce(full);
      }
    }


    // cache for deletion
    lastScan = {
      at: Date.now(),
      idsToDelete,
      missingCovers // full path
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
      await ensureAttachedTx(sequelize, t, 'meta', metadataSqliteFile)

      // 1) delete manga rows (bulk)
      if (ids.length) {
        await Manga.destroy({ where: { id: ids }, transaction: t });
      }

      // 2) prune only orphan Metadata (safe even if multiple Mangas share a hash)
      await sequelize.query(`
        DELETE FROM meta.Metadata
        WHERE NOT EXISTS (SELECT 1 FROM main.Mangas m WHERE m.hash = meta.Metadata.hash)
      `, { transaction: t });
      });

    // Remove cover files on disk (best-effort, after DB succeeds)
    if (coversToRemove.length) {
      await Promise.allSettled(coversToRemove.map(p => fsp.rm(p, { force: true })));
    }

    // vacuum if requested
    if (vacuum) {
      await Manga.sequelize.query(`VACUUM;`)
      await Metadata.sequelize.query(`VACUUM;`)
    }
    lastScan = null;
    return { ok: true };
})

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
  const coverFilePath = path.join(staticFilePath, path.basename(manga.coverPath))
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
// keep track of the current url
function wireNavigationForwarders(rec) {
  const { id, view, target } = rec
  const sendSafe = (channel, payload) => {
    if (!target.isDestroyed()) target.send(channel, payload)
  }

  const onDidNavigate = (_ev, url) => {
    sendSafe('wcv:did-navigate', { id, url })
  }
  const onDidNavigateInPage = (_ev, details) => {
    sendSafe('wcv:did-navigate-in-page', { id, url: details && details.url })
  }

  view.webContents.on('did-navigate', onDidNavigate)
  view.webContents.on('did-navigate-in-page', onDidNavigateInPage)

  rec._unsubNav = () => {
    view.webContents.removeListener('did-navigate', onDidNavigate)
    view.webContents.removeListener('did-navigate-in-page', onDidNavigateInPage)
  }
}
// mouse back/forward buttons
function enableMouseNav(host, view, id) {
  const key = `__wcv_nav_${id}`
  if (host[key]) return
  const handler = (_e, cmd) => {
    try {
      if (cmd === 'browser-backward') {
        if (view.webContents.canGoBack()) view.webContents.goBack()
      } else if (cmd === 'browser-forward') {
        if (view.webContents.canGoForward()) view.webContents.goForward()
      }
    } catch {}
  }
  host.on('app-command', handler)
  host[key] = handler
}
function disableMouseNav(host, id) {
  const key = `__wcv_nav_${id}`
  const handler = host[key]
  if (handler) {
    try { host.removeListener('app-command', handler) } catch {}
    delete host[key]
  }
}

// Alt+Left/Right or Cmd+[Cmd+] for back/forward
function enableKeyboardNav(host, view, id) {
  const key = `__wcv_kb_${id}`
  if (host[key]) return

  const handleKey = (input) => {
    if (input.type !== 'keyDown') return false
    const isMac = process.platform === 'darwin'
    const k = input.key // e.g., 'ArrowLeft', 'ArrowRight', '[' , ']'
    const alt = !!input.alt
    const ctrl = !!input.control
    const meta = !!input.meta
    const shift = !!input.shift

    // Back
    if (isMac) {
      if (meta && !alt && !ctrl && !shift && k === '[') {
        if (view.webContents.canGoBack()) view.webContents.goBack()
        return true
      }
    } else {
      if (alt && !meta && !ctrl && !shift && (k === 'ArrowLeft' || k === 'Left')) {
        if (view.webContents.canGoBack()) view.webContents.goBack()
        return true
      }
    }

    // Forward
    if (isMac) {
      if (meta && !alt && !ctrl && !shift && k === ']') {
        if (view.webContents.canGoForward()) view.webContents.goForward()
        return true
      }
    } else {
      if (alt && !meta && !ctrl && !shift && (k === 'ArrowRight' || k === 'Right')) {
        if (view.webContents.canGoForward()) view.webContents.goForward()
        return true
      }
    }

    return false
  }

  const onHostKey = (event, input) => {
    if (handleKey(input)) try { event.preventDefault() } catch {}
  }
  const onViewKey = (event, input) => {
    if (handleKey(input)) try { event.preventDefault() } catch {}
  }

  host.webContents.on('before-input-event', onHostKey)
  view.webContents.on('before-input-event', onViewKey)

  host[key] = { onHostKey, onViewKey, view }
}

function disableKeyboardNav(host, id) {
  const key = `__wcv_kb_${id}`
  const bag = host[key]
  if (!bag) return
  try { host.webContents.removeListener('before-input-event', bag.onHostKey) } catch {}
  try { bag.view && bag.view.webContents.removeListener('before-input-event', bag.onViewKey) } catch {}
  delete host[key]
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
  wireNavigationForwarders(rec)

  enableMouseNav(rec.host, rec.view, payload.id)
  enableKeyboardNav(rec.host, rec.view, payload.id)
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
  disableKeyboardNav(rec.host, id)
  disableMouseNav(rec.host, id)
  return { ok: true }
})
