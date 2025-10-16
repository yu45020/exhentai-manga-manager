<template>
  <SearchDialogBrowser ref="browserRef"
                       v-model:visible="dialogVisibleEhSearch"
                       @confirm="onConfirm"
                       @confirmPartialUpdate="onConfirmPartialUpdate"
  />
</template>
<script setup lang="ts">
/** The following contains functions to parse metadata from various online sources and batch get metadata function
 *  It also opens the sub browser window for searching books manually via `openSearchDialog`
 *  Browser configurations are in SearchDialogBrowser.vue
 *  The child component handles the dialog display
 *  The variable `dialogVisibleEhSearch` is two-way proxy computed with the child component's `visible` prop
 * */

import { nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'

import he from 'he'
import SearchDialogBrowser from './SearchDialogBrowser.vue'

import { fetchNhentaiMeta, fetchNhentaiPartialMeta } from '../scrapers/nhentai'
import { fetchEhExPartialMeta } from '../scrapers/exeh'
import { storeToRefs } from 'pinia'
import { useAppStore } from '../pinia.js'

const appStore = useAppStore()
const {
  categoryOption,
  setting, bookList, serviceAvailable,
  cookie, tag2cat
} = storeToRefs(appStore)
const { printMessage, returnTrimFileName, saveBook } = appStore

const { t } = useI18n()
// const emit = defineEmits<{ (e: 'confirm', payload: { bookDetail, url: string }): void }>()

const dialogVisibleEhSearch = ref(false)
const searchResultLoading = ref(false)
const ehSearchResultList = ref([])
const browserRef = ref<typeof SearchDialogBrowser>(null)

async function openSearchDialog(book) {
  dialogVisibleEhSearch.value = true
  await nextTick()
  const api = browserRef.value
  if (!api?.openSearchDialogBrowser) {
    console.warn('SearchDialogBrowser API not available (ref missing or method not exposed).')
  }
  await api.openSearchDialogBrowser(book)
}

const resolveSearchResult = (bookId, url, type) => {
  const book = _.find(bookList.value, { id: bookId })
  if (type === 'hentag') {
    book.url = url
    getBookInfoFromHentag(book)
  } else if (type === 'e-hentai') {
    book.url = url
    getBookInfoFromEh(book)
  }
  dialogVisibleEhSearch.value = false
}
const getBookInfoFromHentag = async (book) => {
  const data = await fetch(`https://hentag.com/public/api/vault/${book.url.slice(25)}`).then(res => res.json())
  const tags = {}
  data.language === 11 ? tags['language'] = ['chinese', 'translated'] : ''
  data.parodies.length > 0 ? tags['parody'] = data.parodies.map(parody => parody.name) : ''
  data.characters.length > 0 ? tags['character'] = data.characters.map(character => character.name) : ''
  data.circles.length > 0 ? tags['group'] = data.circles.map(circle => circle.name) : ''
  data.artists.length > 0 ? tags['artist'] = data.artists.map(artist => artist.name) : ''
  data.maleTags.length > 0 ? tags['male'] = data.maleTags.map(maleTag => maleTag.name) : ''
  data.femaleTags.length > 0 ? tags['female'] = data.femaleTags.map(femaleTag => femaleTag.name) : ''
  if (data.otherTags.length > 0) {
    data.otherTags.forEach(({ name }) => {
      const cat = tag2cat.value[name]
      if (cat) {
        if (tags[cat]) {
          tags[cat].push(name)
        } else {
          tags[cat] = [name]
        }
      } else {
        if (tags['misc']) {
          tags['misc'].push(name)
        } else {
          tags['misc'] = [name]
        }
      }
    })
  }
  _.assign(book, {
    title: data.title,
    posted: Math.floor(data.createdAt / 1000),
    // doujinshi category value is 1
    category: categoryOption.value[data.category - 1],
    tags
  })
  book.status = 'tagged'
  await saveBook(book)
}

const getBookInfoFromEh = async (book) => {
  const match = /(\d+)\/([a-z0-9]+)/.exec(book.url)
  const res = await ipcRenderer.invoke('post-data-ex', {
    url: 'https://api.e-hentai.org/api.php',
    data: {
      'method': 'gdata',
      'gidlist': [
        [+match[1], match[2]]
      ],
      'namespace': 1
    }
  })

  // when mismatched: {"gmetadata":[{"gid":12345,"error":"Key missing, or incorrect key provided."}]}
  try {
    _.assign(
        book,
        _.pick(JSON.parse(res).gmetadata[0], ['tags', 'title', 'title_jpn', 'filecount', 'rating', 'posted', 'filesize', 'category']),
    )
    book.posted = +book.posted
    book.filecount = +book.filecount
    book.rating = +book.rating
    book.title = he.decode(book.title)
    book.title_jpn = he.decode(book.title_jpn)
    const tagObject = _.groupBy(book.tags, tag => {
      const result = /(.+):/.exec(tag)
      if (result) {
        return /(.+):/.exec(tag)[1]
      } else {
        return 'misc'
      }
    })
    _.forIn(tagObject, (arr, key) => {
      tagObject[key] = arr.map(tag => {
        const result = /:(.+)$/.exec(tag)
        if (result) {
          return /:(.+)$/.exec(tag)[1]
        } else {
          return tag
        }
      })
    })
    book.tags = tagObject
    book.status = 'tagged'

    await saveBook(book)
  } catch (e) {
    console.log(e)
    if (_.includes(res, 'Your IP address has been')) {
      book.status = 'non-tag'
      printMessage('error', t('c.ipBanned'))
      await saveBook(book)
      serviceAvailable.value = false
    } else {
      book.status = 'tag-failed'
      printMessage('error', t('c.getMetadataFailed'))
      await saveBook(book)
    }
  }
}

const getBookInfoFromNH = async (book) => {
  const wcId = browserRef.value.id
  const meta = await fetchNhentaiMeta(book.url, wcId)
  if (!meta.title) {
    console.log("Fail to parse page from nhentai")
    book.status = 'tag-failed'
    printMessage('error', t('c.getMetadataFailed'))
    await saveBook(book)
  }
  try {
    _.assign(book, {
      title: meta.title,
      title_jpn: meta.title_jpn,
      tags: meta.tags,
      category: meta.category,
      filecount: meta.pages,
    })
    book.status = 'tagged'
    await saveBook(book)
  } catch (e) {
    console.log(e)
    book.status = 'tag-failed'
    printMessage('error', t('c.getMetadataFailed'))
    await saveBook(book)
  }
}
const getBookInfo = (book) => {
  if (book.url.startsWith('https://hentag.com')) {
    getBookInfoFromHentag(book)
  } else if (book.url.includes('exhentai') || book.url.includes('e-hentai')) {
    getBookInfoFromEh(book)
  } else if (book.url.includes('nhentai')) {
    getBookInfoFromNH(book)
  }
}

// use in the main window to batch get metadata
const getBooksMetadata = async (bookList, gap, callback) => {
  const server = setting.value.defaultScraper || 'exhentai'
  serviceAvailable.value = true
  const timer = ms => new Promise(res => setTimeout(res, ms))
  const messageInstance = ElMessage({
    message: t('c.gettingMetadata'),
    type: 'success',
    duration: 0,
    showClose: true,
    onClose: () => {
      serviceAvailable.value = false
    }
  })
  for (let i = 0; i < bookList.length; i++) {
    ipcRenderer.invoke('set-progress-bar', (i + 1) / bookList.length)
    const book = bookList[i]
    try {
      if (serviceAvailable.value) {
        if (!book.url) {
          const resultList = await getBookListFromWeb(
              book.hash.toUpperCase(),
              returnTrimFileName(book),
              server,
              book.filepath
          )
          if (!resultList[0]) {
            book.status = 'tag-failed'
            await saveBook(book)
          } else {
            resolveSearchResult(book.id, resultList[0].url, resultList[0].type)
          }
        } else {
          getBookInfo(book)
        }
        await timer(gap)
      }
    } catch (error) {
      book.status = 'tag-failed'
      await saveBook(book)
      console.error(error)
    }
  }
  messageInstance.close()
  ipcRenderer.invoke('set-progress-bar', -1)
  printMessage('success', t('c.getMetadataComplete'))
  callback?.()
}

const getBookListFromWeb = async (bookHash, title, server = 'e-hentai', bookPath = '') => {
  let resultList = []
  searchResultLoading.value = true
  if (server === 'e-hentai') {
    resultList = await fetch(`https://e-hentai.org/?f_shash=${bookHash}&fs_similar=on&fs_exp=on&f_cats=161`)
        .then(res => res.text())
        .then(res => {
          return resolveEhentaiResult(res)
        })
  } else if (server === 'exhentai') {
    resultList = await ipcRenderer.invoke('get-ex-webpage', {
          url: `https://exhentai.org/?f_shash=${bookHash}&fs_similar=on&fs_exp=on&f_cats=161`,
          cookie: cookie.value
        })
        .then(res => {
          return resolveEhentaiResult(res)
        })
  } else if (server === 'e-search') {
    resultList = await fetch(`https://e-hentai.org/?f_search=${encodeURI(title)}&f_cats=161`)
        .then(res => res.text())
        .then(res => {
          return resolveEhentaiResult(res)
        })
  } else if (server === 'exsearch') {
    resultList = await ipcRenderer.invoke('get-ex-webpage', {
          url: `https://exhentai.org/?f_search=${encodeURI(title)}&f_cats=161`,
          cookie: cookie.value
        })
        .then(res => {
          return resolveEhentaiResult(res)
        })
  } else if (server === 'hentag') {
    resultList = await fetch(`https://hentag.com/public/api/vault-search?t=${encodeURI(title)}`)
        .then(res => res.json())
        .then(res => {
          return resolveHentagResult(res)
        })
  } else if (server === '.ehviewer') {
    const ehviewerData = await ipcRenderer.invoke('get-ehviewer-data', bookPath)

    ehSearchResultList.value = []
    if (ehviewerData) {
      resultList = [{
        title,
        url: `https://exhentai.org/g/${ehviewerData.gid}/${ehviewerData.token}/`,
        type: 'e-hentai'
      }]
      ehSearchResultList.value = resultList
    }
  }
  searchResultLoading.value = false
  return resultList
}


const resolveEhentaiResult = (htmlString) => {
  try {
    const resultNodes = new DOMParser().parseFromString(htmlString, 'text/html').querySelectorAll('.gl3c.glname')
    ehSearchResultList.value = []
    resultNodes.forEach((node) => {
      ehSearchResultList.value.push({
        title: node.querySelector('.glink').innerHTML,
        url: node.querySelector('a').getAttribute('href'),
        type: 'e-hentai'
      })
    })
    return ehSearchResultList.value
  } catch (e) {
    console.log(e)
    if (htmlString.includes('Your IP address has been')) {
      serviceAvailable.value = false
      printMessage('error', t('c.ipBanned'))
    } else {
      printMessage('error', t('c.getMetadataFailed'))
    }
  }
}

const resolveHentagResult = (data) => {
  const resultList = data.works.slice(0, 10)
  ehSearchResultList.value = []
  resultList.forEach((result) => {
    const findExUrl = result.locations.find((location) => location.startsWith('https://exhentai.org'))
    if (findExUrl) {
      ehSearchResultList.value.push({
        title: result.title,
        url: findExUrl,
        type: 'e-hentai'
      })
    } else {
      ehSearchResultList.value.push({
        title: result.title,
        url: `https://hentag.com/vault/${result.id}`,
        type: 'hentag'
      })
    }
  })
  return ehSearchResultList.value
}

async function onConfirm({ bookDetail, url }) {
  const cleaned = (url ?? '').trim()
  if (!cleaned) return
  bookDetail.url = cleaned
  // await saveBook(bookDetail)
  try {
    await getBookInfo(bookDetail)
  } catch (e) {
    console.log('onConfirm failed', e)
    bookDetail.status = 'tag-failed'
    await saveBook(bookDetail)
  } finally {
    dialogVisibleEhSearch.value = false
  }

}

async function onConfirmPartialUpdate({ bookDetail, url, wcId }) {
  // only update the artist/group/category/cosplayer tags
  let meta
  if (url.includes('exhentai') || url.includes('e-hentai')) {
    meta = await fetchEhExPartialMeta(url, wcId)
  } else if (url.includes('nhentai')) {
    meta = await fetchNhentaiPartialMeta(url, wcId)
  }
  try {
    _.assign(bookDetail, {
      tags: meta.tags,
      category: meta.category,
    })
    bookDetail.status = 'tagged'
    await saveBook(bookDetail)
  } catch (e) {
    console.log(e)
    bookDetail.status = 'tag-failed'
    await saveBook(bookDetail)
  } finally {
    dialogVisibleEhSearch.value = false
  }
}

defineExpose({
  dialogVisibleEhSearch,
  openSearchDialog,
  getBookInfo,
  getBooksMetadata,
  getBookInfoFromEh
})

</script>

<style lang="stylus">
.dialog-search
  .el-form-item
    margin-right: 4px

  .search-input
    width: calc(60vw - 152px)

</style>