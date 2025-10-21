import { markRaw, ref } from 'vue'

const normStr = (s) => (s == null ? '' : String(s).trim())

export function tagCatalogSlice() {
  // --- Internal state (non-reactive heavy structures) ---
  // Names (append-only at runtime)
  let allNameSet = markRaw(new Set())                 // Set<tag>
  let byCatNameMap = markRaw(new Map())               // Map<cat, Set<tag>>

  // Counts (only rebuilt from full bookList)
  let allCountMap = markRaw(new Map())                // Map<tag, number>
  let byCatCountMap = markRaw(new Map())              // Map<cat, Map<tag, number>>

  // Small reactive flag to notify consumers that outputs changed
  const version = ref(0)

  // Caches (names)
  let allNamesCache = null
  let allNamesCacheVer = -1
  const byCatNamesCache = markRaw(new Map())          // Map<cat, {ver, arr:string[] }>
  let allCatsNamesCache = null
  let allCatsNamesCacheVer = -1
  // Caches (counts)
  let allCountsCache = null
  let allCountsCacheVer = -1
  const byCatCountsCache = markRaw(new Map())         // Map<cat, {ver, arr:{name,count}[] }>

  const byCatTranslationCountsCache = markRaw(new Map())         // Map<cat, {ver, arr:{name, jp, count}[] }>

  let allCatsTranslationCountsCache = null
  let allCatsTranslationCountsCacheVer = -1

  let allCatsCountsCache = null
  let allCatsCountsCacheVer = -1

  // Keyed by `${cat}||${translate ? 1 : 0}||${tVer}||${version.value}`
  const byCatTranslationCache = markRaw(new Map()) // Map<string, {verKey, arr}>
// Keyed by `ALL||${translateFlag}||${tVer}||${version.value}`
  let allCatsTranslationCache = null
  let allCatsTranslationCacheKey = ''


  // Helpers
  const ensureCatNameSet = (cat) => {
    if (!byCatNameMap.has(cat)) byCatNameMap.set(cat, markRaw(new Set()))
    return byCatNameMap.get(cat)
  }

  const bump = () => {
    version.value++ // triggers components that read outputs via computed()
  }

  // --- API: rebuild everything from a full book list ---
  function rebuildFromBooks(bookList) {
    const tmpAllNames = new Set()
    const tmpByCatNames = new Map()
    const tmpAllCounts = new Map()
    const tmpByCatCounts = new Map()

    const toTagSet = (val) => {
      if (val == null) return new Set()
      const arr = Array.isArray(val) ? val : [val]
      const out = new Set()
      for (const t of arr) {
        const s = normStr(t)
        if (s) out.add(s)
      }
      return out
    }

    for (const book of bookList || []) {
      const tagsObj = book?.tags
      if (!tagsObj || typeof tagsObj !== 'object') continue

      for (const [catRaw, value] of Object.entries(tagsObj)) {
        const cat = normStr(catRaw)
        if (!cat) continue
        const tags = toTagSet(value)
        if (tags.size === 0) continue

        // name sets (per category)
        let catNameSet = tmpByCatNames.get(cat)
        if (!catNameSet) {
          catNameSet = new Set()
          tmpByCatNames.set(cat, catNameSet)
        }

        // count maps (per category)
        let catCountMap = tmpByCatCounts.get(cat)
        if (!catCountMap) {
          catCountMap = new Map()
          tmpByCatCounts.set(cat, catCountMap)
        }

        for (const tag of tags) {
          // names
          tmpAllNames.add(tag)
          catNameSet.add(tag)

          // counts
          tmpAllCounts.set(tag, (tmpAllCounts.get(tag) || 0) + 1)
          catCountMap.set(tag, (catCountMap.get(tag) || 0) + 1)
        }
      }
    }

    // Swap internals (markRaw so Vue doesn't try to proxy)
    allNameSet = markRaw(tmpAllNames)
    byCatNameMap = markRaw(tmpByCatNames)
    allCountMap = markRaw(tmpAllCounts)
    byCatCountMap = markRaw(tmpByCatCounts)

    // Invalidate caches
    allNamesCache = null
    allNamesCacheVer = -1
    byCatNamesCache.clear()

    allCountsCache = null
    allCountsCacheVer = -1
    byCatCountsCache.clear()

    allCatsNamesCache = null
    allCatsNamesCacheVer = -1

    allCatsTranslationCountsCache = null
    allCatsTranslationCountsCacheVer = -1
    byCatTranslationCountsCache.clear()


    allCatsCountsCache = null
    allCatsCountsCacheVer = -1

    byCatTranslationCache.clear()
    allCatsTranslationCache = null
    allCatsTranslationCacheKey = ''
    bump()
  }

  // --- API: append-only single tag add (manual editor) ---
  function addTag(catRaw, tagRaw) {
    const cat = normStr(catRaw)
    const tag = normStr(tagRaw)
    if (!cat || !tag) return

    const catSet = ensureCatNameSet(cat)

    const beforeAll = allNameSet.size
    const beforeCat = catSet.size

    allNameSet.add(tag)
    catSet.add(tag)

    if (allNameSet.size !== beforeAll || catSet.size !== beforeCat) {
      // Invalidate name caches only
      allNamesCacheVer = -1
      allCatsNamesCacheVer = -1
      allCountsCacheVer = -1
      allCatsTranslationCountsCacheVer = -1
      allCatsCountsCacheVer = -1
      byCatNamesCache.delete(cat)
      bump()
    }
  }


  // --- API: read all unique tags (sorted) ---
  function getAllTags() {

    if (allNamesCache && allNamesCacheVer === version.value) return allNamesCache
    const arr = Array.from(allNameSet)
    arr.sort()
    allNamesCache = arr
    allNamesCacheVer = version.value
    return allNamesCache
  }

  function getTagsByCategory(catRaw) {

    const cat = normStr(catRaw)
    const cached = byCatNamesCache.get(cat)
    if (cached && cached.ver === version.value) return cached.arr

    const set = byCatNameMap.get(cat)
    const arr = set ? Array.from(set) : []
    arr.sort()
    byCatNamesCache.set(cat, { ver: version.value, arr })
    return arr
  }

  // Returns { [category]: string[] } with each array sorted by name
  function getTagsAllCategories() {
    if (allCatsNamesCache && allCatsNamesCacheVer === version.value) {
      return allCatsNamesCache
    }
    const out = Object.fromEntries(
        Array.from(byCatNameMap.entries()).map(([cat, set]) => {
          const arr = set ? Array.from(set) : []
          arr.sort()
          return [cat, arr]
        })
    )

    allCatsNamesCache = out
    allCatsNamesCacheVer = version.value
    return out
  }

  function getAllTagsWithCount() {
    if (allCountsCache && allCountsCacheVer === version.value) return allCountsCache
    const arr = Array.from(allCountMap.entries()).map(([name, count]) => ({ name, count }))
    arr.sort((a, b) => a.name.localeCompare(b.name))
    allCountsCache = arr
    allCountsCacheVer = version.value
    return allCountsCache
  }

  function getTagsByCategoryWithCount(catRaw) {
    const cat = normStr(catRaw)
    const cached = byCatCountsCache.get(cat)
    if (cached && cached.ver === version.value) return cached.arr

    const m = byCatCountMap.get(cat)
    const arr = m ? Array.from(m.entries()).map(([name, count]) => ({ name, count })) : []
    arr.sort((a, b) => a.name.localeCompare(b.name))
    byCatCountsCache.set(cat, { ver: version.value, arr })
    return arr
  }


// Returns { [category]: { name, count }[] } with each array sorted by name
  function getTagsAllCategoriesWithCount() {
    if (allCatsCountsCache && allCatsCountsCacheVer === version.value) {
      return allCatsCountsCache
    }

    const out = Object.fromEntries(
        Array.from(byCatCountMap.entries()).map(([cat, m]) => {
          const arr = m
              ? Array.from(m.entries()).map(([name, count]) => ({ name, count }))
              : []
          arr.sort((a, b) => a.name.localeCompare(b.name))
          return [cat, arr]
        })
    )

    allCatsCountsCache = out
    allCatsCountsCacheVer = version.value
    return out
  }


  // used in the folder tree side panel
  function getTagsByCategoryWithTranslationCount(catRaw, { translate = (name) => name } = {}) {
    const cat = normStr(catRaw)
    const cached = byCatTranslationCountsCache.get(cat)
    if (cached && cached.ver === version.value) return cached.arr

    const m = byCatCountMap.get(cat)
    const arr = m ? Array.from(m.entries()).map(
        ([name, count]) => ({ name, jp: translate(name, cat), count })) : []
    arr.sort((a, b) => a.name.localeCompare(b.name))
    byCatTranslationCountsCache.set(cat, { ver: version.value, arr })
    return arr
  }

  function getTagsAllCategoriesWithTranslationCount({ translate = (name) => name } = {}) {
    if (allCatsTranslationCountsCache && allCatsTranslationCountsCacheVer === version.value) {
      return allCatsTranslationCountsCache
    }

    const out = Object.fromEntries(
        Array.from(byCatCountMap.entries()).map(([cat, m]) => {
          const arr = m
              ? Array.from(m.entries()).map(([name, count]) => ({ name, jp: translate(name, cat), count }))
              : []
          arr.sort((a, b) => a.name.localeCompare(b.name))
          return [cat, arr]
        })
    )

    allCatsTranslationCountsCache = out
    allCatsTranslationCountsCacheVer = version.value
    return out
  }

  //


  function getTagByCategoryWithTranslation(catRaw, {
    showTranslate = false,
    translate = (name) => name,
    tVer = 0
  } = {}) {

    const cat = normStr(catRaw)
    const key = `${cat}||${showTranslate ? 1 : 0}||${tVer}||${version.value}`
    const cached = byCatTranslationCache.get(key)
    if (cached) return cached.arr

    const set = byCatNameMap.get(cat)
    const names = set ? Array.from(set) : []
    names.sort()

    const arr = names.map((name) => ({
      value: name,
      label: showTranslate ? `${translate(name, cat)} || ${name}` : name,
    }))

    byCatTranslationCache.set(key, { verKey: key, arr })
    return arr
  }

  function getTagAllCategoriesWithTranslation({ showTranslate = false, translate = (name) => name, tVer = 0 } = {}) {
    // used in BookDetailDialog `el-select-v2`, so we need to keep the same array format
    const key = `ALL||${showTranslate ? 1 : 0}||${tVer}||${version.value}`
    if (allCatsTranslationCache && allCatsTranslationCacheKey === key) return allCatsTranslationCache
    console.log('getAllTagOptions')

    const out = Object.fromEntries(
        Array.from(byCatNameMap.entries()).map(([cat, set]) => {
          const names = set ? Array.from(set) : []
          names.sort()
          const xlate = names.map((name) => ({
            value: name,
            label: showTranslate ? `${translate(name, cat)} || ${name}` : name,
          }))
          return [cat, xlate]
        })
    )

    allCatsTranslationCache = out
    allCatsTranslationCacheKey = key
    return out
  }

// Public API
  return {
    // core
    rebuildFromBooks,
    addTag,

    // names
    getAllTags,
    getTagsByCategory,

    // counts (optional, handy for UIs)
    getAllTagsWithCount,
    getTagsByCategoryWithCount,

    getTagsAllCategories,
    getTagsAllCategoriesWithCount,

    // for el-select-v2 in BookDetailDialog
    getTagByCategoryWithTranslation,
    getTagAllCategoriesWithTranslation,

    // folder tree side panel
    getTagsByCategoryWithTranslationCount,
    getTagsAllCategoriesWithTranslationCount,
  }
}
