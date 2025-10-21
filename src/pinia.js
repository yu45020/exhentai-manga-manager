import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { isReactive, markRaw, shallowRef, toRaw, unref } from 'vue'
import { tagCatalogSlice } from './stores/slices/tagCatalogSlice'
import { translationSlice } from './stores/slices/translationSlice'

// ----------------------- translator end -----------------------
export const useAppStore = defineStore('appStore', {
  state: () => ({
    cat2letter: {
      language: 'l',
      parody: 'p',
      character: 'c',
      group: 'g',
      artist: 'a',
      female: 'f',
      male: 'm',
      mixed: 'x',
      other: 'o',
      cosplayer: 'cos',
      category: 'cat'
    },
    keyMap: {
      normal: {
        next: 'ArrowRight',
        prev: 'ArrowLeft',
        click: 1
      },
      reverse: {
        next: 'ArrowLeft',
        prev: 'ArrowRight',
        click: -1
      }
    },
    statusOption: [
      'non-tag',
      'tagged',
      'tag-failed',
      'need-verify'
    ],
    categoryOption: [
      'Doujinshi',
      'Manga',
      'Artist CG',
      'Game CG',
      'Non-H',
      'Image Set',
      'Western',
      'Cosplay',
      'Asian Porn',
      'Misc',
    ],
    searchTypeList: [
      { label: 'exhentai(sha1)', value: 'exhentai' },
      { label: 'e-hentai(sha1)', value: 'e-hentai' },
      // TODO: Only eh/ex-hentai guarantee unique results in the public api search method
      // { label: 'exhentai(keyword)', value: 'exsearch' },
      // { label: 'e-hentai(keyword)', value: 'e-search' },
      // { label: 'hentag(keyword)', value: 'hentag' },
      // { label: 'exhentai(.ehviewer file from EhViewer)', value: '.ehviewer' },
    ],
    setting: {},
    bookDetail: {},
    // resolvedTranslation: {}, don't bind it to the translation dict as it's big
    bookList: [],
    dbSignature: {}, // defined in saveAppCache in index.js
    displayBookList: [],
    chunkDisplayBookList: [],
    collectionList: [],
    openCollectionBookList: [],
    serviceAvailable: true,
    sortValue: undefined,
    editCollectionView: false,
    editTagView: false,
    localeFile: null,
    folderTreeData: [],
    artistTreeData: [],
    groupTreeData: [],
    parodyTreeData: [],
    isUpdateMethodBusy: false,
    numVerifyMatch: 0,
    _tagSlice: null,
    _translationSlice: null,
  }),
  getters: {
    cookie: (state) => {
      return `igneous=${state.setting.igneous};ipb_pass_hash=${state.setting.ipb_pass_hash};ipb_member_id=${state.setting.ipb_member_id};star=${state.setting.star}`
    },
    pathSep: () => {
      return ipcRenderer.sendSync('get-path-sep')
    },
    displayBookCount(state) {
      if (state.sortValue === 'hidden') {
        return _.sumBy(state.displayBookList, book => book.hiddenBook ? 1 : 0)
      }
      return _.sumBy(state.displayBookList, book => this.isVisibleBook(book) ? 1 : 0)
    },

    tagList(state) {
      // 1) Collect unique (cat, name) pairs without building strings
      const uniq = new Map() // cat -> Set(names)
      for (const b of state.bookList) {
        if (b.hiddenBook || b.folderHide) continue
        const tags = b.tags || {}
        for (const cat in tags) {
          const arr = tags[cat] || []
          let set = uniq.get(cat)
          if (!set) {
            set = new Set()
            uniq.set(cat, set)
          }
          for (let i = 0; i < arr.length; i++) set.add(arr[i])
        }
      }

      // 2) Emit a single flattened, optionally translated list
      const out = []
      for (const [cat, set] of uniq) {
        const letter = state.cat2letter[cat] || cat
        // sort raw names per category (mimics your old raw sort; if you want global sort by label, see note below)
        const names = Array.from(set).sort()
        for (const name of names) {
          const tagLabel = this.translate(name, cat) || name
          const catLabel = this.translate(cat, 'rows') || cat
          out.push({
            label: `${catLabel}:${tagLabel}`,
            value: `${letter}:"${name}"`,
          })
        }
      }

      // Optional: global sort by rendered label (costs one extra pass; do this
      // only if your UI needs cross-category alphabetical order by translated text)
      // out.sort((a, b) => a.label.localeCompare(b.label));

      return out
    },
    tagListRaw(state) {
      // 1) Collect unique (cat, tag) pairs
      const uniq = new Map() // cat -> Set(tags)

      const list = state.bookList || []
      for (let i = 0; i < list.length; i++) {
        const b = list[i]
        if (!b || b.hiddenBook || b.folderHide) continue

        const tagsObj = b.tags || {}
        for (const cat in tagsObj) {
          const arr = tagsObj[cat]
          if (!arr || !arr.length) continue

          let set = uniq.get(cat)
          if (!set) {
            set = new Set()
            uniq.set(cat, set)
          }
          for (let j = 0; j < arr.length; j++) set.add(arr[j])
        }
      }

      // 2) Emit a sorted, flat array: sort cats, then tags within cat
      const out = []
      const cats = Array.from(uniq.keys()).sort()
      for (let c = 0; c < cats.length; c++) {
        const cat = cats[c]
        const letter = state.cat2letter[cat] || cat
        const names = Array.from(uniq.get(cat)).sort()

        for (let n = 0; n < names.length; n++) {
          const tag = names[n]
          out.push({
            id: `${cat}:${tag}`,
            letter,
            cat,
            tag,
          })
        }
      }

      return out
    },
    tagListForSelect(state) {
      // read once — keeps reactivity cheap
      const doTrans = !!state.setting.showTranslation
      // Source list should already be unique tuples: { letter, cat, tag }
      const src = this.tagListRaw

      // Optional tiny memo if layered translation is a bit heavy.
      // Keyed by cat + "\u0001" + tag.
      const memo = doTrans ? new Map() : null

      const out = new Array(src.length)
      for (let i = 0; i < src.length; i++) {
        const { letter, cat, tag } = src[i]
        const suffix = `${letter}:"${tag}"`

        let catLabel, tagLabel

        const mkey = cat + '\u0001' + tag
        let hit = memo.get(mkey)
        if (hit) {
          if (hit.catLabel) catLabel = hit.catLabel
          if (hit.tagLabel) tagLabel = hit.tagLabel
        } else {
          catLabel = this.translate(tag, cat) || cat
          tagLabel = this.translate(cat, 'rows') || tag
          memo.set(mkey, { catLabel, tagLabel })
        }

        // If you still want a special-case for `group`, do it *after* translator:
        // if (cat === 'group' && catLabel === 'group') catLabel = '团队'

        out[i] = {
          label: `${catLabel}:${tagLabel} || ${suffix}`,
          value: suffix,
        }
      }

      // If your UI needs an alphabetical dropdown by rendered label, enable:
      out.sort((a, b) => a.label.localeCompare(b.label))
      return out
    },

    tag2cat(state) {
      const temp = {}
      const tagArray = _(state.bookList.map(b => {
        return _.map(b.tags, (tags, cat) => {
          return _.map(tags, tag => `${cat}##${tag}`)
        })
      }))
          .flattenDeep().value()
      const uniqedTagArray = [...new Set(tagArray)]
      uniqedTagArray.forEach(combinedTag => {
        const tagArray = _.split(combinedTag, '##')
        temp[tagArray[1]] = tagArray[0]
      })
      return temp
    },
    customOptions(state) {
      return _.compact(_.get(state.setting, 'customOptions', '').split('\n'))
          .map(str => ({
            label: str.trim(),
            value: str.trim().replace(/\s+(?=(?:[^\'"]*[\'"][^\'"]*[\'"])*[^\'"]*$)/g, '|||')
          }))
    },
    visibleChunkDisplayBookList(state) {
      return state.chunkDisplayBookList.filter(book => !book.collectionHide && (state.sortValue === 'hidden' || !book.hiddenBook) && !book.folderHide)
    },
    visibleChunkDisplayBookListForCollectView(state) {
      return state.chunkDisplayBookList.filter(book => !book.isCollection && !book.folderHide && !book.hiddenBook)
    },
    visibleChunkDisplayBookListForEditTagView(state) {
      return state.chunkDisplayBookList.filter(book => !book.isCollection && !book.folderHide)
    },
    needVerifyCount(state) {
      return state.bookList.filter(b => b?.status === 'need-verify').length
    }
  },
  actions: {
    isBook(book) {
      // isCollection mean book is collection
      return !book.isCollection
    },
    isVisibleBook(book) {
      // folderHide mean book hide by not selecting at folder tree
      // collectionHide mean book hide because book in collection
      // hiddenBook mean book hide by user operation
      return !book.folderHide && !book.collectionHide && !book.hiddenBook
    },
    printMessage(type, msg) {
      ElMessage.closeAll()
      ElMessage[type]({
        message: msg,
        offset: 50
      })
    },
    returnFileNameWithExt(filepath) {
      return filepath.split(/[/\\]/).pop()
    },
    returnFileName(book) {
      const fileNameWithExtension = this.returnFileNameWithExt(book.filepath)
      if (book.type === 'folder') return fileNameWithExtension
      return fileNameWithExtension.split('.').slice(0, -1).join('.')
    },
    returnTrimFileName(book) {
      const fileNameWithExtension = this.returnFileNameWithExt(book.filepath)
      let fileNameWithoutExtension = fileNameWithExtension
      try {
        if (book.type !== 'folder') {
          fileNameWithoutExtension = fileNameWithExtension.split('.').slice(0, -1).join('.')
        }
        if (this.setting.trimTitleRegExp) {
          fileNameWithoutExtension = fileNameWithoutExtension.replace(new RegExp(this.setting.trimTitleRegExp, 'g'), '')
        }
        if (this.setting.searchKeySuffix) {
          fileNameWithoutExtension = fileNameWithoutExtension + ' ' + this.setting.searchKeySuffix
        }
      } catch (e) {
        console.log(e)
      }
      return fileNameWithoutExtension
    },
    getDisplayTitle(book) {
      switch (this.setting.displayTitle) {
        case 'englishTitle':
          return book.title
        case 'japaneseTitle':
          return book.title_jpn || book.title
        case 'filename':
          return this.returnFileName(book)
        default:
          return book.title_jpn || book.title || this.returnFileName(book)
      }
    },
    async resetMetadata(book) {
      book.title = this.returnFileName(book)
      book.title_jpn = null
      book.posted = null
      book.filecount = null
      book.rating = null
      book.filesize = null
      book.category = null
      book.tags = {}
      book.status = 'non-tag'
      book.url = null
      await this.saveBook(book)
    },
    async saveBook(book) {
      return ipcRenderer.invoke('save-book', _.cloneDeep(book))
    },
    async switchMark(book) {
      book.mark = !book.mark
      await this.saveBook(book)
    },
    isChineseTranslatedManga(book) {
      return _.includes(book?.tags?.language, 'chinese') ? true : false
    },
    copyTagClipboard(book) {
      ipcRenderer.invoke('copy-text-to-clipboard', JSON.stringify(_.pick(book, ['tags', 'status', 'category'])))
    },
    async pasteTagClipboard(book) {
      const text = await ipcRenderer.invoke('read-text-from-clipboard')
      _.assign(book, JSON.parse(text))
      await this.saveBook(book)
    },
    filterFolderMethod(node, keyword) {
      if (!keyword) return true
      const label = node.text || node.label || ''
      return label.toLowerCase().includes(keyword.toLowerCase())
    },
    // only need to call this in the App.vue  `setup()`
    ensureTranslation() {
      if (this._translationSlice) return
      const slice = translationSlice()
      // the folder tree panel always needs translation, so we load it here
      slice.ensureTranslationLoaded()
      Object.assign(this, {
        ensureTranslationLoaded: slice.ensureTranslationLoaded,
        echoTranslator: slice.makeEchoTranslator(),
        translator: slice.makeTranslator()
      })
      this._translationSlice = slice
    },

    translate(name, category, { type = 'name', alwaysShow = false } = {}) {
      // type: 'name' | 'intro' as shown in the json dict
      const fn = alwaysShow ? this.translator :
          (this.setting.showTranslation ? this.translator : this.echoTranslator)

      return fn(name, category, { type: type }) || String(name ?? '')
    },

    // Create/attach the slice once per store instance
    ensureTagSlice() {
      if (this._tagSlice) return
      const slice = tagCatalogSlice()

      // expose minimal API on the store instance
      Object.assign(this, {
        rebuildFromBooks: slice.rebuildFromBooks,
        addTag: slice.addTag,
        getAllTags: slice.getAllTags,
        getTagsByCategory: slice.getTagsByCategory,
        getTagsByCategoryWithCount: slice.getTagsByCategoryWithCount,
        getAllTagsWithCount: slice.getAllTagsWithCount,
        getTagsAllCategories: slice.getTagsAllCategories,
        getTagsAllCategoriesWithCount: slice.getTagsAllCategoriesWithCount,
        getTagByCategoryWithTranslation: slice.getTagByCategoryWithTranslation,
        getTagAllCategoriesWithTranslation: slice.getTagAllCategoriesWithTranslation,
        getTagsByCategoryWithTranslationCount: slice.getTagsByCategoryWithTranslationCount,
        getTagsAllCategoriesWithTranslationCount: slice.getTagsAllCategoriesWithTranslationCount

      })

      this._tagSlice = slice
    },
    // Call this after you load books from DB or after a scan
    // async loadBooks(books) {
    //   this.bookList = Array.isArray(books) ? books : []
    //   this.ensureTagSlice()
    //   this.rebuildFromBooks(this.bookList)
    // },
    // If somewhere else you directly mutate bookList and want to rebuild:
    rebuildTagCatalog() {
      this.ensureTagSlice()
      this.rebuildFromBooks(this.bookList)
    },

  }
})

// used to save objects
export function toPlain(input, seen = new WeakSet()) {
  const v = unref(input)
  if (v === null || typeof v !== 'object') return v

  // break Vue reactivity
  const raw = isReactive(v) ? toRaw(v) : v

  if (seen.has(raw)) return undefined // drop cycles (or handle with IDs)
  seen.add(raw)

  if (Array.isArray(raw)) return raw.map(x => toPlain(x, seen))

  const out = {}
  for (const [k, val] of Object.entries(raw)) {
    if (typeof val === 'function') continue          // drop methods
    if (k.startsWith('_') || k === 'parent') continue // drop likely backrefs
    out[k] = toPlain(val, seen)
  }
  return out
}