const fs = require('fs')
const path = require('node:path')
const { nanoid } = require('nanoid')
const { createHash } = require('crypto')
const sharp = require('sharp')
const {
  getFolderlist,
  solveBookTypeFolderInMem,
  solveBookTypeFolder,
  getImageListFromFolder,
  deleteImageFromFolder
} = require('./folder.js')
const {
  getArchivelist,
  solveBookTypeArchive,
  getImageListFromArchive,
  deleteImageFromArchive,
  solveBookTypeArchiveInMem,
  geneCoverSharp
} = require('./archive.js')
const { makeShardedPath  } = require('./utils.js')

const { getZipFilelist, solveBookTypeZip } = require('./zip.js')
const { TEMP_PATH, COVER_PATH, VIEWER_PATH } = require('../modules/init_folder_setting.js')

const getBookFilelist = async (library) => {
  const folderList = await getFolderlist(library)
  const archiveList = await getArchivelist(library)
  const zipList = await getZipFilelist(library)
  return [
    ...folderList.map(filepath => ({ filepath, type: 'folder' })),
    ...archiveList.map(filepath => ({ filepath, type: 'archive' })),
    ...zipList.map(filepath => ({ filepath, type: 'zip' })),
  ]
}

const geneCover = async (filepath, type) => {
  let targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime
  switch (type) {
    case 'folder':
      ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeFolder(filepath, TEMP_PATH, COVER_PATH))
      break
    case 'zip':
      try {
        ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, TEMP_PATH, COVER_PATH))
      } catch (e) {
        console.log(`reload ${filepath} use adm-zip`)
        ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeZip(filepath, TEMP_PATH, COVER_PATH))
      }
      break
    case 'archive':
      ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, TEMP_PATH, COVER_PATH))
      break
  }

  const coverHash = createHash('sha1').update(fs.readFileSync(tempCoverPath)).digest('hex')
  const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(tempCoverPath))
  await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })
  await fs.promises.copyFile(tempCoverPath, copyTempCoverPath)
  await sharp(copyTempCoverPath, { failOnError: false })
    .resize(500, 707, {
      fit: 'contain',
      background: '#303133'
    })
    .toFile(coverPath)
  return { targetFilePath, coverPath, pageCount, bundleSize, mtime, coverHash }
}

const getImageListByBook = async (filepath, type) => {
  switch (type) {
    case 'folder':
      return await getImageListFromFolder(filepath, VIEWER_PATH)
    case 'zip':
    case 'archive':
      return await getImageListFromArchive(filepath, VIEWER_PATH)
    default:
      return await getImageListFromArchive(filepath, VIEWER_PATH)
  }
}

const deleteImageFromBook = async (filename, filepath, type) => {
  switch (type) {
    case 'folder':
      return await deleteImageFromFolder(filename, filepath)
    case 'zip':
    case 'archive':
      return await deleteImageFromArchive(filename, filepath)
    default:
      return await deleteImageFromArchive(filename, filepath)
  }
}

const geneCoverFromBuffer = async (filepath, type, opts={}) => {

  let targetBuffer, coverBuffer, coverPath, pageCount, bundleSize, mtime, useBuffer, targetFilePath, tempCoverPath,
      hash, coverHash, coverSharp
  if (type === 'folder') {
    ({
      targetBuffer,
      coverBuffer,
      pageCount,
      bundleSize,
      mtime
    } = await solveBookTypeFolderInMem(filepath))
    useBuffer = true
    coverPath = makeShardedPath(COVER_PATH, nanoid() + '.webp')
  } else {
    try {
      ({
        targetBuffer,
        coverBuffer,
        pageCount,
        bundleSize,
        mtime
      } = await solveBookTypeArchiveInMem(filepath, opts))
      coverPath = makeShardedPath(COVER_PATH, nanoid() + '.webp')
      useBuffer = true
    } catch (e1) {
      console.log(`reload ${filepath} by 7z`)
      try {
        ({
          targetFilePath,
          coverPath,
          tempCoverPath,
          pageCount,
          bundleSize,
          mtime
        } = await solveBookTypeArchive(filepath, TEMP_PATH, COVER_PATH, opts))
        useBuffer = false
      } catch (e2) {
        console.log(`reload ${filepath} use adm-zip`);
        ({
          targetFilePath,
          coverPath,
          tempCoverPath,
          pageCount,
          bundleSize,
          mtime
        } = await solveBookTypeZip(filepath, TEMP_PATH, COVER_PATH,opts))
        useBuffer = false
      }
    }
  }
  if (useBuffer) {
    hash = createHash('sha1').update(targetBuffer).digest('hex')
    coverHash = createHash('sha1').update(coverBuffer).digest('hex')
    coverSharp = await geneCoverSharp(coverBuffer, coverPath);
    // the simple version may cause pngload_buffer or vipsjpeg error

  } else {
    hash = createHash('sha1').update(fs.readFileSync(targetFilePath)).digest('hex')
    coverHash = createHash('sha1').update(fs.readFileSync(tempCoverPath)).digest('hex')
    const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(tempCoverPath))
    await fs.promises.copyFile(tempCoverPath, copyTempCoverPath)
    coverSharp = await sharp(copyTempCoverPath, { failOnError: false })
        .resize(500, 707, {
          fit: 'contain',
          background: '#303133'
        })
  }
  return { hash, coverPath, pageCount, bundleSize, mtime, coverHash, coverSharp }
}

module.exports = {
  getBookFilelist,
  geneCover,
  getImageListByBook,
  deleteImageFromBook,
  geneCoverFromBuffer,
  makeShardedPath
}