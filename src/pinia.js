import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { isReactive, reactive, toRaw, unref, markRaw, shallowRef } from 'vue'

// ----------------------- translator  -----------------------

// used to translate a list of tags in random tags 

function makeEchoTranslator() {
  return markRaw((name) => (String(name ?? '')))
}

function makeTranslator(translator) {
  // type: 'name' | 'intro'
  const resolver = translator?.value || translator

  function resolve(name, category, { type = 'name' } = {}) {
    const out = resolver(name, category)
    if (out && typeof out === 'object' && type in out) return out[type]
    else if (typeof out === 'string') return out
    else return name
  }

  return markRaw(resolve)
}
// todo: remove them
function _makeEchoTranslator() {
  return markRaw((name, category) => ({ name: String(name ?? ''), intro: undefined }))
}

function _makeTranslator(translateTag) {
  // Accept either a ref(fn) or a plain fn
  const resolver = translateTag?.value || translateTag
  if (typeof resolver !== 'function') return makeEchoTranslator()

  const resolve = (name, category, type) => {
    // type: 'name' | 'intro'
    if (name) {
      const out = resolver(name, category)
      if (out && typeof out === 'object' && type in out) return out[type]
      else if (typeof out === 'string') return out
    }

  }
  const translator = (name, category, { type = 'name', tagOnly = true } = {}) => {
    // console.log('name', name, 'category', category, 'type', type, 'tagOnly', tagOnly)
    // Defensive: support resolve() returning either {name} or a string
    // let tagLabel = name
    // let catLabel = category
    try {
      const tagLabel = resolve(name, category, type)
      const catLabel = resolve(category, 'rows', 'name') || ''
      const out = { catLabel, tagLabel }
      if (tagOnly) {
        return out.tagLabel
      } else {
        return out
      }

    } catch (_) { /* swallow and echo */ }
  }

  return markRaw(translator)
}

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
      { label: 'exhentai(keyword)', value: 'exsearch' },
      { label: 'e-hentai(keyword)', value: 'e-search' },
      { label: 'hentag(keyword)', value: 'hentag' },
      { label: 'exhentai(.ehviewer file from EhViewer)', value: '.ehviewer' },
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
    translatorFn: shallowRef(makeEchoTranslator()),
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
    tagList_(state) {
      const tagArray = _(state.bookList.filter(b => {
        return !b.hiddenBook && !b.folderHide
      }).map(b => {
        return _.map(b.tags, (tags, cat) => {
          return _.map(tags, tag => `${cat}##${tag}`)
        })
      }))
          .flattenDeep().value()
      const uniqedTagArray = [...new Set(tagArray)].sort()
      return uniqedTagArray.map(combinedTag => {
        const tagArray = _.split(combinedTag, '##')
        const letter = state.cat2letter[tagArray[0]] ? state.cat2letter[tagArray[0]] : tagArray[0]
        let labelHeader = tagArray[0]
        let labelTail = tagArray[1]
        // TODO: fix me
        if (state.setting.showTranslation) {
          labelHeader = tagArray[0] === 'group' ? '团队' : state.resolvedTranslation[tagArray[0]]?.name || tagArray[0]
          labelTail = state.resolvedTranslation[tagArray[1]]?.name || tagArray[1]
        }
        return {
          label: `${labelHeader}:${labelTail}`,
          value: `${letter}:"${tagArray[1]}"`
        }
      })
    },
    tagList(state) {

      // const translate = (name, category) => state.setting.showTranslation ? state.translatorFn(name, category, { tagOnly: false }) : null
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
    tagListRaw_(state) {
      const tagArray = _(state.bookList.map(b => {
        return _.map(b.tags, (tags, cat) => {
          return _.map(tags, tag => `${cat}##${tag}`)
        })
      }))
          .flattenDeep().value()
      const uniqedTagArray = [...new Set(tagArray)].sort()
      return uniqedTagArray.map(combinedTag => {
        const tagArray = _.split(combinedTag, '##')
        const letter = state.cat2letter[tagArray[0]] ? state.cat2letter[tagArray[0]] : tagArray[0]
        return {
          id: `${tagArray[0]}:${tagArray[1]}`,
          letter,
          cat: tagArray[0],
          tag: tagArray[1],
        }
      })
    },
    tagListForSelect_(state) {
      if (state.setting.showTranslation) {
        return state.tagListRaw.map(({ letter, cat, tag }) => {
          // todo fix me
          const labelHeader = cat === 'group' ? '团队' : state.resolvedTranslation[cat]?.name || cat
          const labelTail = state.resolvedTranslation[tag]?.name || tag
          return {
            label: `${labelHeader}:${labelTail} || ${letter}:"${tag}"`,
            value: `${letter}:"${tag}"`
          }
        })
      } else {
        return state.tagListRaw.map(({ letter, cat, tag }) => {
          return {
            label: `${cat}:${tag} || ${letter}:"${tag}"`,
            value: `${letter}:"${tag}"`
          }
        })
      }
    },
    tagListForSelect(state) {
      // read once — keeps reactivity cheap
      const doTrans = !!state.setting.showTranslation
      // const translate = (name, category) => doTrans ? state.translatorFn(name, category, { tagOnly: false }) : null

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
    saveBook(book) {
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
    translate(name, category, { type = 'name' } = {}) {
      // if translation is off, just echo
      if (!this.setting.showTranslation) return String(name ?? '')
      const rec = this.translatorFn(name, category, { type: type })
      return rec || String(name ?? '')
    },
    setTranslation(translator) {
      this.translatorFn = makeTranslator(translator) || makeEchoTranslator()
    },
    disableTranslation() {
      this.translatorFn = makeEchoTranslator()
    }
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