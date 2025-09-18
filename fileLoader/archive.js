const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const { nanoid } = require('nanoid')
const { spawn } = require('child_process')
const _ = require('lodash')
const iconv = require('iconv-lite')
const { getRootPath } = require('../modules/utils.js')
const sharp = require('sharp')

const _7z = path.join(getRootPath(), 'resources/extraResources/7z.exe')
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

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

const solveBookTypeArchive = async (filepath, TEMP_PATH, COVER_PATH) => {
  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  await fs.promises.mkdir(tempFolder, { recursive: true })
  // Make 'l' output UTF-8 so Japanese paths are correct
  const output = await spawnPromise(_7z, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'])
  let pathlist = _.filter(output.split(/\r\n/), s => _.startsWith(s, 'Path') && !_.includes(s, '__MACOSX'))
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
  let coverPath
  if (imageList.length > 8) {
    targetFile = imageList[7]
    coverFile = imageList[0]


    await spawnPromise(_7z, ['x', '-o'+tempFolder, '-p123456', '-y', "--",  filepath,  targetFile])
    await spawnPromise(_7z, ['x', '-o'+tempFolder, '-p123456', '-y', "--",  filepath,  coverFile])
  } else if (imageList.length > 0) {
    targetFile = imageList[0]
    coverFile = imageList[0]
    await spawnPromise(_7z, ['x', '-o'+tempFolder, '-p123456', '-y', "--",  filepath,  targetFile])
  } else {
    throw new Error('compression package isnot include image')
  }
  targetFilePath = path.join(TEMP_PATH, nanoid(8) + path.extname(targetFile))
  await fs.promises.copyFile(path.join(tempFolder, targetFile), targetFilePath)

  tempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(coverFile))
  await fs.promises.copyFile(path.join(tempFolder, coverFile), tempCoverPath)

  coverPath = path.join(COVER_PATH, nanoid() + '.webp')

  const fileStat = await fs.promises.stat(filepath)
  return {targetFilePath, tempCoverPath, coverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime}
}

const getImageListFromArchive = async (filepath, VIEWER_PATH) => {
  const tempFolder = path.join(VIEWER_PATH, nanoid(8))
  await fs.promises.mkdir(tempFolder, { recursive: true })

  await spawnPromise(_7z, ['x', filepath, '-o' + tempFolder, '-p123456'], 2 * 60 * 1000)
  let list = globSync('**/*.@(jpg|jpeg|png|webp|avif|gif|bmp)', {
    cwd: tempFolder,
    nocase: true
  })
  list = _.filter(list, s => !_.includes(s, '__MACOSX'))
  list = list.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))
  return list.map(f => ({
    relativePath: f,
    absolutePath: path.join(tempFolder, f)
  }))
}

const deleteImageFromArchive = async (filename, filepath) => {
  await spawnPromise(_7z, ['d', filepath, filename, '-p123456'])
  return true
}

const spawnPromise = (commmand, argument, timeoutMs = 30 * 1000) => {
  return new Promise((resolve, reject) => {
    const spawned = spawn(commmand, argument)
    const output = []
    const timeout = setTimeout(() => {
      spawned.kill()
      reject('7z return timeout')
    }, timeoutMs) // 默认30s超时

    spawned.on('error', data => {
      clearTimeout(timeout)
      reject(data)
    })
    spawned.on('exit', code => {
      clearTimeout(timeout)
      const stdout = Buffer.concat(output).toString('utf8')   // decode once as UTF-8

      if (code === 0) {
        setTimeout(() => resolve(output.join('\r\n')), 50)
      } else {
        reject('close code is ' + code)
      }
    })
    spawned.stdout.on('data', data => {
      output.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
    })
  })
}

/**  =======   extract files into RAM and return buffers   =======  */
// two methods: libarchive-wasm (fast, small files), 7z-wasm (stream large files)
// ZIP/CBZ → use libarchive-wasm if ≤ 400 MB, otherwise 7z-wasm
// RAR/CBR, 7Z/CB7 and the rest 7z-wasm (regardless of size)
const SIZE_THRESHOLD = 100 * 1024 * 1024; // 200 MB because it consumes 2x RAM and have many workers
const ZIP_LIKE_EXTS = new Set(['.zip', '.cbz']);
const SEVENZ_EXTS = new Set(['.7z', '.cb7']);


function isImage(p) {
  const name = String(p || '');
  if (!name || name.endsWith('/')) return false;          // skip directories
  if (name.startsWith('__MACOSX/') || name.startsWith('._')) return false; // skip Apple junk
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

function pickCoverAndTarget(imageList) {
  const pageCount = imageList.length;
  if (pageCount === 0) return { pageCount, coverFile: null, targetFile: null };
  const coverFile = imageList[0];
  const targetFile = (pageCount > 8) ? imageList[7] : imageList[0];
  return { pageCount, coverFile, targetFile };
}

/** =========================
 * use libarchive-wasm to load small files
 * ========================= */

let _laModPromise = null;

async function getLibarchiveModule() {
  if (_laModPromise) return _laModPromise;
  const { libarchiveWasm } = await import('libarchive-wasm');
  _laModPromise = libarchiveWasm();
  return _laModPromise;
}

async function getBufferFromLibarchive(filepath) {
  // console.log("Hello from libarchive-wasm", filepath);
  const { ArchiveReader } = await import('libarchive-wasm');
  // Read archive bytes (libarchive-wasm consumes Int8Array)
  const mod = await getLibarchiveModule();

  const archiveBuf = await fs.promises.readFile(filepath);
  const bytes = new Int8Array(archiveBuf);
  // console.log("bytes length", bytes.length);
  // Pass 1: list images in natural/alphanumeric order
  let imageList;
  {
    const reader = new ArchiveReader(mod, bytes);
    try {
      const imgs = [];
      for (const entry of reader.entries()) {
        const name = entry.getPathname();
        if (isImage(name)) imgs.push(name);
      }
      // Natural/alphanumeric order (1,2,10)
      imgs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      imageList = imgs;
    } finally {
      // Free the reader immediately (important: many archives in a row)
      // NOTE: ArchiveReader has no explicit free per entry; freeing the reader is enough
      // The module itself is reused across calls.
      reader.free?.();
    }
  }
  const { pageCount, coverFile, targetFile } = pickCoverAndTarget(imageList);

  if (!coverFile || !targetFile) {
    throw new Error('libarchive-wasm: no images found in archive.');
  }

  // Pass 2: extract only the needed entries
  const reader = new ArchiveReader(mod, bytes);
  let coverBuffer = null;
  let targetBuffer = null;

  try {
    // console.log("hello from libarchive-wasm, extracting", coverFile, targetFile);
    for (const entry of reader.entries()) {
      const name = entry.getPathname();
      if (!name) continue;

      if (name === coverFile || name === targetFile) {
        const u8 = entry.readData(); // Uint8Array (entry's full content in memory)
        const buf = Buffer.from(u8);
        if (name === coverFile) coverBuffer = buf;
        if (name === targetFile) targetBuffer = buf;

        // Stop early when both found (saves CPU for big archives)
        if (coverBuffer && targetBuffer) break;
      }
    }
  } finally {
    reader.free?.();
  }
  if (!coverBuffer || !targetBuffer) {
    throw new Error(`libarchive-wasm: failed to read ${filepath}`);
  }
  return { targetBuffer, coverBuffer, pageCount }
}

/** =========================
 *  use the 7z-wasm to stream large files
 *  ========================= */
const spawnBuffer = (command, args, timeoutMs = 60 * 1000) => {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args);
    const chunks = [];
    const errs = [];
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      reject(new Error('7z timed out'));
    }, timeoutMs);

    p.stdout.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    p.stderr.on('data', (d) => errs.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const msg = Buffer.concat(errs).toString('utf8') || `7z exited with code ${code}`;
        reject(new Error(msg));
      }
    });
  });
};

async function listImagesWith7z(filepath) {
  // -slt gives machine-friendly "Key = Value" lines; -sccUTF-8 forces UTF-8 output
  // include password so encrypted headers can be listed
  const listing = await spawnPromise(_7z, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'], 2 * 60 * 1000);
  const lines = String(listing).split(/\r?\n/);

  const entries = [];
  let cur = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (cur && cur.path) entries.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = {};
    if (line.startsWith('Path = ')) {
      cur.path = line.slice(7);
    } else if (line.startsWith('Folder = ')) {
      const v = line.slice(9).trim();
      cur.isDir = v === '+' || v.toLowerCase() === 'true';
    }
  }
  if (cur && cur.path) entries.push(cur);

  let imgs = entries
      .filter(e => !e.isDir && typeof e.path === 'string' && !e.path.includes('__MACOSX'))
      .map(e => e.path)
      .filter(p => IMAGE_EXTS.has(path.extname(p).toLowerCase()));

  imgs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return imgs;
}

async function extractFileToBuffer7z(filepath, innerPath) {
  // Use `x` to preserve subfolders when selecting; -so streams file bytes to stdout.
  // -y assume Yes on all queries; -p123456 matches existing convention (ignored if not needed).
  const args = ['x', '-so', '-y', '-p123456', '-mmt=1','-bso0', '-bsp0', '--', filepath, innerPath,];
  return await spawnBuffer(_7z, args, 5 * 60 * 1000);
}

async function getBufferFrom7z(filepath) {
  // Use native 7-Zip and keep everything in RAM.
  // 1) List images deterministically (natural sort)
  const imageList = await listImagesWith7z(filepath);
  // 2) Pick cover (first) and a middle-ish target (8th if available)
  const { pageCount, coverFile, targetFile } = pickCoverAndTarget(imageList);
  if (pageCount === 0) {
    throw new Error('No images found inside archive');
  }
  // 3) Stream-extract just the two images into Buffers via -so (no disk I/O)
  const coverBuffer = await extractFileToBuffer7z(filepath, coverFile);
  const targetBuffer = (targetFile === coverFile)
      ? coverBuffer
      : await extractFileToBuffer7z(filepath, targetFile);

  return { targetBuffer, coverBuffer, pageCount };
}

/** =========================
 * main function
 * ========================= */


async function solveBookTypeArchiveInMem(filepath) {
  // Basic file meta
  const ext = path.extname(filepath).toLowerCase();
  const fileStat = await fs.promises.stat(filepath);
  const bundleSize = fileStat.size;
  const mtime = fileStat?.mtime;
  let targetBuffer, coverBuffer, pageCount
  if (bundleSize <= SIZE_THRESHOLD) {
    if (SEVENZ_EXTS.has(ext)) {
      // 1) 7z family → 7z-wasm first
      try {
        ({ targetBuffer, coverBuffer, pageCount } = await getBufferFrom7z(filepath));
      } catch (e7z) {
        console.log(`In Mem ${filepath}: 7z failed, reload with libarchive`);
        ({ targetBuffer, coverBuffer, pageCount } = await getBufferFromLibarchive(filepath));
      }
    } else if (ZIP_LIKE_EXTS.has(ext)) {
      // 2) ZIP/CBZ → choose by size
      try {
        ({ targetBuffer, coverBuffer, pageCount } = await getBufferFromLibarchive(filepath));
      } catch (e7z) {
        console.log(`In Mem ${filepath}: Libarchive failed, reload with 7z`);
        ({ targetBuffer, coverBuffer, pageCount } = await getBufferFrom7z(filepath));
      }
    } else {
      try {
        ({ targetBuffer, coverBuffer, pageCount } = await getBufferFrom7z(filepath));
      } catch (e7z) {
        console.log(`In Mem ${filepath}: 7z failed, reload with libarchive`);
        ({ targetBuffer, coverBuffer, pageCount } = await getBufferFromLibarchive(filepath));
      }
    }
  } else {
    // don't use libarchive as it loads the file into RAM and takes 2x RAM
    // ({ targetBuffer, coverBuffer, pageCount } = await getBufferFrom7z(filepath));
    try {
      ({ targetBuffer, coverBuffer, pageCount } = await getBufferFrom7z(filepath));
    } catch (e7z) {
      console.log(`In Mem ${filepath}: large file 7z failed, reload with libarchive`);
      ({ targetBuffer, coverBuffer, pageCount } = await getBufferFromLibarchive(filepath));
    }
  }

  return {
    targetBuffer,
    coverBuffer,
    pageCount,
    bundleSize,
    mtime,
  };
}

/** =========================
 * Creating Thumbnail from Buffer
 * ========================= */
// need to patch JPEG EOI sometimes

// patch jpeg EOI if missing
const JPEG_EOI = Buffer.from([0xFF, 0xD9]);
const isJpeg = (buf) => buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
const hasEOI = (buf) => buf && buf.length > 1 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;

// open sharp tolerantly (newer + older sharp)
function openSharp(buf) {
  try { return sharp(buf, { failOn: 'none', sequentialRead: true, limitInputPixels: false }); }
  catch { return sharp(buf, { failOnError: false, sequentialRead: true, limitInputPixels: false }); }
}
async function geneCoverSharp(coverBuffer, coverPath) {
  const build = (buf) =>
    openSharp(buf)
      .rotate()
      .resize(500, 707, {
        fit: 'contain',
        background: '#303133',
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      }) ;

  try {
    return build(coverBuffer) ;
  } catch (e1) {
    // Try JPEG EOI auto-patch (fixes "VipsJpeg: Premature end of input file")
    if (isJpeg(coverBuffer) && !hasEOI(coverBuffer)) {
      const patched = Buffer.concat([coverBuffer, JPEG_EOI]);
      try {
        return build(patched) ;
      } catch (e2) { /* fallthrough to placeholder */ }
    }
    // Last resort: simple placeholder (WEBP)
    console.log("Failed to create thumbnail, used placeholder instead:", coverPath);
    return sharp({ create: { width: 500, height: 707, channels: 3, background: '#303133' } })
  }
}
module.exports = {
  getArchivelist,
  solveBookTypeArchive,
  getImageListFromArchive,
  deleteImageFromArchive,
  solveBookTypeArchiveInMem,
  geneCoverSharp
}