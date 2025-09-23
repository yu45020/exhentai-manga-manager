const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const { nanoid } = require('nanoid')
const { spawn } = require('child_process')
const _ = require('lodash')
const { getRootPath } = require('../modules/utils.js')
const sharp = require('sharp')

const _7z = path.join(getRootPath(), 'resources/extraResources/7z.exe')
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])

const getArchivelist = async (libraryPath) => {
  const list = globSync('**/*.@(rar|7z|cb7|cbr)', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: true,
    absolute: true
  })
  return list
}

const solveBookTypeArchive = async (filepath, TEMP_PATH, opts = {}) => {

  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  await fs.promises.mkdir(tempFolder, { recursive: true })
  // Make 'l' output UTF-8 so Japanese paths are correct
  const output = await spawnBuffer(_7z, ['l', '-slt', '-sccUTF-8', '-p123456', '--', filepath], opts)
  let pathlist = _.filter(String(output).split(/\r\n/), s => _.startsWith(s, 'Path') && !_.includes(s, '__MACOSX'))
  pathlist = pathlist.map(p => {
    const match = /(?<== ).*$/.exec(p)
    return match ? match[0] : ''
  })
  let imageList = _.filter(pathlist, p => IMAGE_EXTS.has(path.extname(p).toLowerCase()))
  imageList = imageList.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))

  let targetFile
  let targetFilePath
  let coverFile
  let tempCoverPath
  if (imageList.length > 8) {
    targetFile = imageList[7]
    coverFile = imageList[0]

    await spawnBuffer(_7z, ['x', '-o' + tempFolder, '-p123456', '-y', '--', filepath, targetFile], opts)
    await spawnBuffer(_7z, ['x', '-o' + tempFolder, '-p123456', '-y', '--', filepath, coverFile], opts)
  } else if (imageList.length > 0) {
    targetFile = imageList[0]
    coverFile = imageList[0]
    await spawnBuffer(_7z, ['x', '-o' + tempFolder, '-p123456', '-y', '--', filepath, targetFile])
  } else {
    throw new Error('compression package isnot include image')
  }
  targetFilePath = path.join(TEMP_PATH, nanoid(8) + path.extname(targetFile))
  await fs.promises.copyFile(path.join(tempFolder, targetFile), targetFilePath)

  tempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(coverFile))
  await fs.promises.copyFile(path.join(tempFolder, coverFile), tempCoverPath)


  const fileStat = await fs.promises.stat(filepath)
  return { targetFilePath, tempCoverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime }
}

const getImageListFromArchive = async (filepath, VIEWER_PATH) => {
  const tempFolder = path.join(VIEWER_PATH, nanoid(8))
  await fs.promises.mkdir(tempFolder, { recursive: true })

  await spawnBuffer(_7z, ['x', '-o' + tempFolder, '-p123456', '--',  filepath], 2 * 60 * 1000)
  let list = globSync('**/*.@(jpg|jpeg|png|webp|avif|gif|bmp)', {
    cwd: tempFolder,
    nocase: true,
  })
  list = _.filter(list, s => !_.includes(s, '__MACOSX'))
  list = list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  return list.map(f => ({
    relativePath: f,
    absolutePath: path.join(tempFolder, f),
  }))
}

const deleteImageFromArchive = async (filename, filepath) => {
  await spawnBuffer(_7z, ['d', filepath, filename, '-p123456'])
  return true
}


/**  =======   extract files into RAM and return buffers   =======  */
// libarchive is about 10x slower, and 7z-wasm fails to open files with Japanese folders inside

/** =========================
 *  use the 7z.exe to stream large files
 *  ========================= */
function pickCoverAndTarget(imageList) {
  const pageCount = imageList.length
  if (pageCount === 0) return { pageCount, coverFile: null, targetFile: null }
  const coverFile = imageList[0]
  const targetFile = (pageCount > 8) ? imageList[7] : imageList[0]
  return { pageCount, coverFile, targetFile }
}

const spawnBuffer = (command, args, opts = {}) => {
  const { signal, timeoutMs = 120_000, onChild } = opts
  // Fast-fail if already aborted
  if (signal?.aborted) {
    const e = new Error('Operation aborted')
    e.name = 'AbortError'
    return Promise.reject(e)
  }

  return new Promise((resolve, reject) => {
    const cp = spawn(command, args,
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal, // Node will throw AbortError + terminate the child on abort
      })
    onChild?.(cp)
    const chunks = []
    const errs = []
    let settled = false
    const done = (err, outBuf) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) try { signal.removeEventListener('abort', onAbort) } catch {}
      if (err) return reject(err)
      resolve(outBuf)
    }

    const onAbort = () => {
      // If the built-in signal didn’t terminate it (older Node/platform edge cases),
      // do a best-effort kill to avoid process leaks.
      try { if (!cp.killed) cp.kill('SIGTERM') } catch {}
      setTimeout(() => { try { if (!cp.killed) cp.kill('SIGKILL') } catch {} }, 3000)
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      // Timeout: force kill and reject
      try { if (!cp.killed) cp.kill('SIGKILL') } catch {}
      done(new Error('7z timed out'))
    }, timeoutMs)

    cp.stdout.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
    cp.stderr.on('data', (d) => errs.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))

    cp.on('error', (e) => done(e))

    cp.on('close', (code) => {
      if (signal?.aborted) {
        const e = new Error('Operation aborted')
        e.name = 'AbortError'
        return done(e)
      }
      if (code === 0) {
        return done(null, Buffer.concat(chunks))
      }
      const msg = Buffer.concat(errs).toString('utf8') || `7z exited with code ${code}`
      done(new Error(msg))
    })
  })
}

async function listImagesWith7z(filepath, opts = {}) {
  // -slt gives machine-friendly "Key = Value" lines; -sccUTF-8 forces UTF-8 output
  // include password so encrypted headers can be listed
  const listing = await spawnBuffer(_7z, ['l', filepath, '-slt', '-mmt=1', '-sccUTF-8', '-p123456'], opts)

  const lines = String(listing).split(/\r?\n/)

  const entries = []
  let cur = null
  for (const line of lines) {
    if (!line.trim()) {
      if (cur && cur.path) entries.push(cur)
      cur = null
      continue
    }
    if (!cur) cur = {}
    if (line.startsWith('Path = ')) {
      cur.path = line.slice(7)
    } else if (line.startsWith('Folder = ')) {
      const v = line.slice(9).trim()
      cur.isDir = v === '+' || v.toLowerCase() === 'true'
    }
  }
  if (cur && cur.path) entries.push(cur)

  let imgs = entries.filter(e => !e.isDir && typeof e.path === 'string' && !e.path.includes('__MACOSX')).
    map(e => e.path).filter(p => IMAGE_EXTS.has(path.extname(p).toLowerCase()))

  imgs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  return imgs
}

async function extractFileToBuffer7z(filepath, innerPath, opts = {}) {
  // Use `x` to preserve subfolders when selecting; -so streams file bytes to stdout.
  // -y assume Yes on all queries; -p123456 matches existing convention (ignored if not needed).
  const { signal, onChild } = opts
  const args = ['x', '-so', '-y', '-p123456', '-mmt=1', '-bso0', '-bsp0', '--', filepath, innerPath]
  return await spawnBuffer(_7z, args, { signal, timeoutMs: 300_000, onChild })
}

async function getBufferFrom7z(filepath, opts = {}) {
  // Use native 7-Zip and keep everything in RAM.
  // 1) List images deterministically (natural sort)
  const imageList = await listImagesWith7z(filepath, opts)
  // 2) Pick cover (first) and a middle-ish target (8th if available)
  const { pageCount, coverFile, targetFile } = pickCoverAndTarget(imageList)
  if (pageCount === 0) {
    throw new Error('No images found inside archive')
  }
  // 3) Stream-extract just the two images into Buffers via -so (no disk I/O)
  const coverBuffer = await extractFileToBuffer7z(filepath, coverFile, opts)
  const targetBuffer = (targetFile === coverFile)
    ? coverBuffer
    : await extractFileToBuffer7z(filepath, targetFile, opts)

  return { targetBuffer, coverBuffer, pageCount }
}

/** =========================
 * main function
 * ========================= */
async function solveBookTypeArchiveInMem(filepath, opts = {}) {
  // Basic file meta
  const fileStat = await fs.promises.stat(filepath)
  const bundleSize = fileStat.size
  const mtime = fileStat?.mtime

  const { targetBuffer, coverBuffer, pageCount } = await getBufferFrom7z(filepath, opts)
  return { targetBuffer,  coverBuffer,  pageCount, bundleSize,  mtime, }
}

/** =========================
 * Creating Thumbnail from Buffer
 * ========================= */
// need to patch JPEG EOI sometimes

// patch jpeg EOI if missing
const JPEG_EOI = Buffer.from([0xFF, 0xD9])
const isJpeg = (buf) => buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
const hasEOI = (buf) => buf && buf.length > 1 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9

// open sharp tolerantly (newer + older sharp)
function openSharp(buf) {
  try { return sharp(buf, { failOn: 'none', sequentialRead: true, limitInputPixels: false }) } catch { return sharp(buf, { failOnError: false, sequentialRead: true, limitInputPixels: false }) }
}

async function geneCoverSharp(coverBuffer) {
  const build = (buf) =>
    openSharp(buf).rotate().resize(500, 707, {
      fit: 'contain',
      background: '#303133',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    })

  try {
    return build(coverBuffer)
  } catch (e1) {
    // Try JPEG EOI auto-patch (fixes "VipsJpeg: Premature end of input file")
    if (isJpeg(coverBuffer) && !hasEOI(coverBuffer)) {
      const patched = Buffer.concat([coverBuffer, JPEG_EOI])
      try {
        return build(patched)
      } catch (e2) { /* fallthrough to placeholder */ }
    }
    // Last resort: simple placeholder (WEBP)
    return sharp({ create: { width: 500, height: 707, channels: 3, background: '#303133' } })
  }
}

module.exports = {
  getArchivelist,
  solveBookTypeArchive,
  getImageListFromArchive,
  deleteImageFromArchive,
  solveBookTypeArchiveInMem,
  geneCoverSharp,
}