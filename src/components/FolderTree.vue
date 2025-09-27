<template>
  <el-drawer v-model="sideVisibleFolderTree"
             :title="$t('m.folderTree')"
             direction="ltr"
             :size="setting.folderTreeWidth ? setting.folderTreeWidth : '28%'"
             modal-class="side-tree-modal"
             @close="closeFolderTree"
  >
    <el-tabs v-model="activeTreeTab" class="tree-tabs">
      <!-- Folder -->
      <el-tab-pane label="Folder" name="folder">
        <div ref="folderToolbarRef" class="folder-toolbar"
             style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
          <!--  Search bar        -->
          <el-input
              class="folder-search"
              v-model="treeFilterText"
              placeholder='Search folder'
              clearable
              size="default"
              @input="() => treeRef?.filter?.(treeFilterText)"
              style="flex:1"
          ></el-input>
          <!-- Side buttons -->
          <div class="icon-group">
            <!--    Expand all /   -->
            <el-tooltip content="Expand all" placement="top">
              <el-button
                  size="default"
                  circle
                  :icon="CirclePlusFilled"
                  aria-label="Expand all"
                  @click="expandAll"
              />
            </el-tooltip>
            <!-- Collapse all -->
            <el-tooltip content="Collapse all" placement="top">
              <el-button
                  size="default"
                  circle
                  :icon="RemoveFilled"
                  aria-label="Collapse all"
                  @click="collapseAll"
              />
            </el-tooltip>
          </div>
        </div>
        <!--  Show all row    -->
        <button
            class="fake-tree-row"
            :class="{ active: isAllActive }"
            type="button"
            @click="resetSelect"
            title="Show all books"
        >
          <el-icon class="fake-tree-row__icon">
            <Folder/>
          </el-icon>
          <span class="fake-tree-row__label">All</span>
        </button>
        <!--        :filter-node-method="filterTreeNode"-->
        <el-tree-v2
            ref="treeRef"
            :data="folderTreeData"
            node-key="folderPath"
            :props="{ value: 'folderPath', label: 'label', children: 'children' }"
            :expand-on-click-node="false"
            :expanded-keys="expandedKeys"
            :filter-method="filterTreeNode"
            @current-change="selectFolderTreeNode"
            :height="treeHeight"
            :item-size="28"
        ></el-tree-v2>
        <el-button class="tree-backtop" circle @click="treeRef.scrollTo(0)" title="Back to top">
          <el-icon>
            <ArrowUp/>
          </el-icon>
        </el-button>
      </el-tab-pane>
      <!-- Artist -->
      <el-tab-pane label="Artist" name="artist">
        <div ref="artistToolbarRef" class="artist-toolbar"
             style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
          <el-input
              class="artist-search"
              v-model="artistFilterText"
              placeholder="Search artist"
              clearable
              @input="() => treeArtistRef?.filter?.(artistFilterText)"
              style="flex:1"
          />
          <el-select v-model="artistSortMode" style="width: 30%;" placeholder="Sort by" @change="rebuildArtist">
            <el-option label="En" value="alpha"/>
            <el-option label="譯" value="tr"/>
            <el-option label="#" value="count"/>
          </el-select>
        </div>
        <!--    virtualized tree in el-tree-v2 is necessary when entries > 10000   -->
        <el-tree-v2
            ref="treeArtistRef"
            :data="artistTreeNodes"
            node-key="artistPath"
            :props="{ value: 'artistPath',  label: 'label' }"
            :expand-on-click-node="false"
            :filter-method="filterNode"
            @current-change="onArtistNodeClick"
            :height="treeHeight"
            :item-size="28"
        />
        <el-button class="tree-backtop" circle @click="treeArtistRef.scrollTo(0)" title="Back to top">
          <el-icon>
            <ArrowUp/>
          </el-icon>
        </el-button>
      </el-tab-pane>
      <!-- Group -->
      <el-tab-pane label="Group" name="group">
        <div class="group-toolbar" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
          <el-input
              class="group-search"
              v-model="groupFilterText"
              placeholder="Search group"
              clearable
              @input="() => treeGroupRef?.filter?.(groupFilterText)"
              style="flex:1"
          />
          <el-select v-model="groupSortMode" style="width: 30%;" placeholder="Sort by" @change="rebuildGroup">
            <el-option label="En" value="alpha"/>
            <el-option label="譯" value="tr"/>
            <el-option label="#" value="count"/>
          </el-select>
        </div>

        <el-tree-v2
            ref="treeGroupRef"
            :data="groupTreeNodes"
            node-key="groupPath"
            :props="{ value: 'groupPath',  label: 'label' }"
            :expand-on-click-node="false"
            :filter-method="filterNode"
            @current-change="onGroupNodeClick"
            :height="treeHeight"
            :item-size="28"
        />
        <el-button class="tree-backtop" circle @click="treeGroupRef.scrollTo(0)" title="Back to top">
          <el-icon>
            <ArrowUp/>
          </el-icon>
        </el-button>
      </el-tab-pane>
      <!-- Parody -->
      <el-tab-pane label="Parody" name="parody">
        <div class="group-toolbar" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
          <el-input
              class="parody-search"
              v-model="parodyFilterText"
              placeholder="Search group"
              clearable
              @input="() => treeParodyRef?.filter?.(parodyFilterText)"
              style="flex:1"
          />
          <el-select v-model="parodySortMode" style="width: 30%;" placeholder="Sort by" @change="rebuildParody">
            <el-option label="En" value="alpha"/>
            <el-option label="譯" value="tr"/>
            <el-option label="#" value="count"/>
          </el-select>
        </div>
        <el-tree-v2
            ref="treeParodyRef"
            :data="parodyTreeNodes"
            node-key="parodyPath"
            :props="{value:'parodyPath',label: 'label' }"
            :expand-on-click-node="false"
            :filter-method="filterNode"
            @current-change="onParodyNodeClick"
            :height="treeHeight"
            :item-size="28"
        />
        <el-button class="tree-backtop" circle @click="treeParodyRef.scrollTo(0)" title="Back to top">
          <el-icon>
            <ArrowUp/>
          </el-icon>
        </el-button>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>

</template>

<script setup>
import { ArrowUp, CirclePlusFilled, RemoveFilled } from '@element-plus/icons-vue'
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, unref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAppStore } from '../pinia.js'

const appStore = useAppStore()

const { setting, bookList, folderTreeData, artistTreeData, groupTreeData, parodyTreeData } = storeToRefs(
    appStore)

// default stays folder, or artist, group, parody
const activeTreeTab = ref('folder')
// artist tab state
const artistFilterText = ref('')
const groupFilterText = ref('')
const parodyFilterText = ref('')
const artistSortMode = ref('alpha') // default sort, or count
const groupSortMode = ref('alpha') // default sort, or count
const parodySortMode = ref('alpha') // default sort, or count

const artistTreeNodes = ref([])
const groupTreeNodes = ref([])
const parodyTreeNodes = ref([])

// const treeFolderRef = ref()
const treeArtistRef = ref()
const treeGroupRef = ref()
const treeParodyRef = ref()
const emit = defineEmits(['chunkList', 'search'])

const sideVisibleFolderTree = ref(false)
const isFolderTreeInit = ref(false)

function openFolderTree() {
  sideVisibleFolderTree.value = true
  if (!isFolderTreeInit.value) geneFolderTree()

}

function closeFolderTree() {
  sideVisibleFolderTree.value = false
}

/** =======================  / construct folder tree
 **/
function buildFolderTree(bookPathList) {
// bookPathList: [ path string, ... ]
// Output node: { label, folderName, folderPath, children:[...] }
// Rule: collapse the top chain while there's exactly one subfolder and no files at that level
// there can be multiple top-level folders

  // Trie node factory
  const makeNode = (name, path) => ({
    folderName: name,
    folderPath: path,
    hasDirect: false,        // at least one file directly in this folder
    _children: new Map(),
  })

  // Build trie
  const rootMap = new Map()
  for (const it of bookPathList || []) {
    const fp = normDir(it)
    if (!fp) continue

    const parts = fp.split('/')
    const dirs = parts.slice(0, -1).filter(Boolean) // drop filename
    if (!dirs.length) continue

    let cursor = rootMap
    let accum = []
    for (let i = 0; i < dirs.length; i++) {
      const seg = dirs[i]
      accum.push(seg)
      let node = cursor.get(seg)
      if (!node) {
        node = makeNode(seg, accum.join('/'))
        cursor.set(seg, node)
      }
      if (i === dirs.length - 1) {
        // file belongs directly under this folder
        node.hasDirect = true
      }
      cursor = node._children
    }
  }

  // Collapse the leading chain while there's only one child and no direct files
  const collapseOne = (node) => {
    let n = node
    while (!n.hasDirect && n._children.size === 1) {
      const [, onlyChild] = n._children.entries().next().value
      n = onlyChild
    }
    return n
  }
  // ---- Per-branch top collapse ----
  const topMap = new Map()
  for (const [, topNode] of rootMap) {
    const collapsed = collapseOne(topNode)
    topMap.set(collapsed.folderPath, collapsed)
  }

  // ---- Convert to Element-Plus-friendly array ----
  const toArray = (map, isTop) => {
    const arr = []
    for (const [, n] of map) {
      arr.push({
        label: isTop ? n.folderPath : n.folderName, // full path at top, name below
        folderName: n.folderName,
        folderPath: n.folderPath,                    // stable node-key
        children: toArray(n._children, false),
      })
    }
    // Sort: top by full path, deeper by name
    arr.sort((a, b) =>
        (isTop ? a.folderPath : a.folderName).localeCompare(isTop ? b.folderPath : b.folderName, undefined,
            { numeric: true, sensitivity: 'base' }),
    )
    return arr
  }

  return toArray(topMap, true)
}

let dirIndex = { keys: [], idxs: [] } // precomputed directory index for fast lookup

const geneFolderTree = async () => {
  // build the folder tab
  const filepaths = bookList.value.filter(b => !b.isCollection).map(b => b.filepath)
  folderTreeData.value = buildFolderTree(filepaths)
  const { keys, idxs } = buildDirIndex(bookList.value)
  dirIndex = { keys, idxs }
  // build the rest tabs
  const { artistList, groupList, parodyList } = await ipcRenderer.invoke('get-additional-folder-trees')
  artistTreeData.value = artistList
  groupTreeData.value = groupList
  parodyTreeData.value = parodyList
  if (translationReady.value) {
    const dict = translationDict?.value
    artistTreeData.value = attachTranslation(artistList, dict?.artist)   // [{ name, jp, count }]
    groupTreeData.value = attachTranslation(groupList, dict?.group)
    parodyTreeData.value = attachTranslation(parodyList, dict?.parody)
  }
  isFolderTreeInit.value = true
  rebuildArtist()
  rebuildGroup()
  rebuildParody()
}

/** Display files by book path
 * Precompute a sorted directory index and use binary search prefix ranges on click to fetch the books under any folder
 * No need to compare each path with the selected folder path
 * */

// Always normalize to POSIX-style '/' and trim trailing '/'
// Lower-case Windows drive letters for case-insensitive compare
function normDir(p) {
  let s = String(p || '').replace(/[\\/]+/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  if (/^[A-Za-z]:/.test(s)) s = s.toLowerCase() // make Windows case-insensitive
  return s
}

// 1) Build a compact directory index once
function buildDirIndex(bookList) {
  const keys = []   // directory path (string)
  const idxs = []   // index into bookList
  for (let i = 0; i < bookList.length; i++) {
    const b = bookList[i]
    // if (b.isCollection) continue;
    const p = b.filepath
    const j = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    const dir = j >= 0 ? p.slice(0, j) : ''
    keys.push(normDir(dir))
    idxs.push(i)
  }
  // sort by keys, keep idxs in sync
  const order = keys.map((_, i) => i).sort((a, b) => {
    const ka = keys[a], kb = keys[b]
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  const sKeys = new Array(order.length)
  const sIdxs = new Array(order.length)
  for (let k = 0; k < order.length; k++) {
    const i = order[k]
    sKeys[k] = keys[i]
    sIdxs[k] = idxs[i]
  }
  return { keys: sKeys, idxs: sIdxs }
}

// 2) Binary search helpers
function lowerBound(keys, key) {
  let lo = 0, hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (keys[mid] < key) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

function upperBound(keys, key) {
  let lo = 0, hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (keys[mid] <= key) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

function computeRange(keys, folderPath) {
  const loKey = normDir(folderPath)
  const hiKey = loKey + '/\uFFFF\uFFFF'// any subdir under base/
  return [lowerBound(keys, loKey), upperBound(keys, hiKey)]
}

// 3) Click handler with per-node cache (_range = [lo, hi])

function selectFolderTreeNode(selectNode) {
  if (!selectNode?.folderPath) return
  // reset visibility first
  bookList.value.forEach(b => { b.folderHide = true })
  if (!selectNode._range) {
    selectNode._range = computeRange(dirIndex.keys, selectNode.folderPath)
  }
  const [lo, hi] = selectNode._range

  // const out = new Array(hi - lo)
  for (let i = lo; i < hi; i++) {
    // out[k] = bookList.value[dirIndex.idxs[i]] // <-- use .value
    bookList.value[dirIndex.idxs[i]].folderHide = false
  }
  emit('chunkList')
}

//

onMounted(async () => {
  const cached = localStorage.getItem('translationFolderDictCache')
  if (cached) {
    translationDict.value = JSON.parse(cached)
    translationReady.value = true
  }
  // avoid blocking the ui
  ;(async () => {
    const fresh = await loadTranslationDict()
    translationDict.value = fresh
    translationReady.value = true
    try { localStorage.setItem('translationFolderDictCache', JSON.stringify(fresh)) } catch {}
  })()

  recomputeTreeHeight()
  window.addEventListener('resize', recomputeTreeHeight)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', recomputeTreeHeight)
})

const treeFilterText = ref('')
const treeRef = ref()

const filterTreeNode = (query, data) => {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true

  const label = String(data?.label ?? '').toLowerCase()
  const folderPath = String(data?.folderPath ?? '').toLowerCase()
  return label.includes(q) || folderPath.includes(q)
}
const resetSelect = () => {
  treeRef.value && treeRef.value.setCurrentKey('')
  bookList.value.forEach(b => { b.folderHide = false })
  emit('chunkList')
}

// expand/collapse all
const expandedKeys = ref([])         // controlled list
const _expandedSet = new Set()       // fast membership

// Collect all folderPath keys in the tree

function collectAllKeys(nodes, out = []) {
  const list = Array.isArray(nodes) ? nodes : (unref(nodes) || [])
  for (const n of list) {
    if (n?.children?.length) {
      out.push(n.folderPathKey || n.folderPath)     // prefer the string key
      collectAllKeys(n.children, out)
    }
  }
  return out
}

function expandAll() {
  const all = collectAllKeys(folderTreeData)
  _expandedSet.clear()
  for (const k of all) _expandedSet.add(k)

  expandedKeys.value = [..._expandedSet]
  nextTick(() => {
    treeRef.value?.setExpandedKeys?.(expandedKeys.value)
  })
}

function collapseAll() {
  _expandedSet.clear()
  expandedKeys.value = []
  nextTick(() => {
    treeRef.value?.setExpandedKeys?.([])
  })
}

/** Additional Tags */

// sorting helpers, Parody is in Chinese
const collatorZh = new Intl.Collator(['zh-Hans', 'zh-Hant', 'en'], {
  sensitivity: 'base', numeric: true, ignorePunctuation: true, collation: 'pinyin',
})
// group and artist are in Japanese
const collatorJa = new Intl.Collator(['ja-JP-u-co-phonebk'], {
  sensitivity: 'base', numeric: true, ignorePunctuation: true,
})
// Unicode ranges
const reKana = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/   // Hiragana, Katakana, Katakana Phonetic, Halfwidth Katakana
const reCJK = /[\u4E00-\u9FFF]/                              // CJK Unified Ideographs (basic block)
const reLatin = /[A-Za-z]/
const reDigit = /[0-9]/

const rankScript = s => {
  for (const ch of s) {
    if (reKana.test(ch)) return 1  // JP
    if (reCJK.test(ch)) return 1  // ZH (CJK)
    if (reLatin.test(ch)) return 2  // EN
    if (reDigit.test(ch)) return 3  // Numbers
    // else keep scanning until we hit a meaningful char
  }
  return 4 // Other/symbols
}

const idMapByNS = new Map()

function makeStableId(ns, name) {
  let map = idMapByNS.get(ns)
  if (!map) {
    map = new Map()
    idMapByNS.set(ns, map)
  }
  const n = (map.get(name) || 0) + 1
  map.set(name, n)
  return n === 1
      ? `${ns}:${encodeURIComponent(name)}`
      : `${ns}:${encodeURIComponent(name)}#${n}`
}

const makeSortKey = s => `${rankScript(s)}|${s.toLowerCase()}`
const sortCache = new Map()
const sortNodesWithCache = (treeData, nodeKey, nodeName, sortMode) => {
  //nodeName: artist|group|parody
  const cacheKey = `${nodeName}:${nodeKey}:${sortMode}`
  const cache = sortCache.get(cacheKey)
  if (cache) return cache // toRaw(unref(treeData))
  const list = (treeData ?? []).filter(
      (x) => x && typeof x.name === 'string',
  )
  const nodes = list.map(({ name, jp, count }) => {
    return {
      label: `${jp}(${name}) (${Number(count) || 0})`, // shown in el-tree
      rawName: name,                             // used by filter
      sortKey: makeSortKey(jp || name),       // used by sorting
      allName: `${name} ${jp || name}`.toLowerCase(), // used by filter
      count: Number(count) || 0,                // used by sorting
      [nodeKey]: makeStableId(nodeName, name),         // dynamic property name
    }
  })

  if (sortMode === 'count') {
    nodes.sort((a, b) => (b.count - a.count) || a.rawName.localeCompare(b.rawName))
  } else if (sortMode === 'tr') {
    if (nodeName === 'parody') {
      nodes.sort((a, b) => collatorZh.compare(a.sortKey, b.sortKey))
    } else {
      nodes.sort((a, b) => collatorJa.compare(a.sortKey, b.sortKey))
    }
  } else {
    nodes.sort((a, b) => a.rawName.localeCompare(b.rawName))
  }
  sortCache.set(cacheKey, nodes)

  return nodes
}

function rebuildArtist() {
  artistTreeNodes.value = sortNodesWithCache(artistTreeData.value, 'artistPath', 'artist', artistSortMode.value)
}

function rebuildGroup() {
  groupTreeNodes.value = sortNodesWithCache(groupTreeData.value, 'groupPath', 'group', groupSortMode.value)
}

function rebuildParody() {
  parodyTreeNodes.value = sortNodesWithCache(parodyTreeData.value, 'parodyPath', 'parody', parodySortMode.value)
}

// filter for artist/group
const filterNode = (query, data) => {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  // allName is pre-lowercased when you build artistTreeNodes
  return String(data?.allName ?? '').includes(q)
}

// response to artist/group node click
const handleSearch = (value) => {
  bookList.value.map(book => book.folderHide = false)
  emit('search', value)
}
const onArtistNodeClick = async (selectNode) => {
  handleSearch(`a:"${selectNode.rawName}"$`)
}
const onGroupNodeClick = async (selectNode) => {
  handleSearch(`g:"${selectNode.rawName}"$`)
}
const onParodyNodeClick = async (selectNode) => {
  handleSearch(`p:"${selectNode.rawName}"$`)
}

// Translation
const translationDict = shallowRef({})
const translationReady = ref(false)

function attachTranslation(list, dict) {
  const d = dict || {}
  return (Array.isArray(list) ? list : []).map(({ name, count }) => ({
    name,
    jp: d?.[name] || name,     // translated display; fallback to raw
    count: Number(count) || 0,
  }))
}

const TRAN_URL = 'https://github.com/EhTagTranslation/Database/releases/latest/download/db.text.json'
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000 // ~30 days

function fetchWithTimeout(url, { timeout = 8000 } = {}) {
  // default 8s timeout
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'AbortError')), timeout)

  return fetch(url).finally(() => clearTimeout(t))
}

function buildTagDicts(source) {
  const out = { group: {}, artist: {}, parody: {} }

  // Normalize to an iterable of { namespace, data }
  const items = Array.isArray(source)
      ? source
      : Object.values(source || {}) // when json.data is an object

  for (const item of items) {
    const ns = item?.namespace
    if (ns === 'group' || ns === 'artist' || ns === 'parody') {
      const data = item?.data || {}
      out[ns] = Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, v?.name]),
      )
    }
  }

  return out // { group: {...}, artist: {...}, parody: {...} }
}

async function _loadTranslationDict() {
  // read cache (supports both new {ts,data} and old flat-object shapes)
  const raw = JSON.parse(localStorage.getItem('translationFolderDictCache') || 'null')
  const cachedData = raw?.data
  const isFresh = (Date.now() - raw?.ts) < ONE_MONTH_MS

  // If cache exists and is fresh, return immediately
  if (cachedData && isFresh) return cachedData

  // Otherwise try to refresh (timeout handled by your fetchWithTimeout helper)
  console.log('Downloading translation file...')
  let resultObject = {}

  try {
    const res = await fetchWithTimeout(TRAN_URL, { timeout: 5000 }) // wait 5s
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const json = await res.json()

    resultObject = buildTagDicts(json?.data)
    // write new-shape cache
    localStorage.setItem('translationFolderDictCache', JSON.stringify({ ts: Date.now(), data: resultObject }))
    return resultObject // { group: {}, artist: {}, parody: {} }
  } catch (err) {
    console.warn('loadTranslationDict refresh failed:', err)
    // fallback to any cached data (
    if (cachedData) return cachedData
    // otherwise fallback to bundled data
    console.log('Using bundled translation data')
    return buildTagDicts((await lazyLoadLocalBackupDict())?.data)
  }
}

async function lazyLoadLocalBackupDict() {
  // dynamic import returns a module object
  const mod = await import('../../resources/extraResources/db.text.json')
  return mod.default // parsed JSON object
}

async function loadTranslationDict() {
  // read cache (supports both new {ts,data} and old flat-object shapes)
  return buildTagDicts((await lazyLoadLocalBackupDict())?.data)
}

// dynamically adjust the virtual window in tabs
// use rule of thumb; change the 200 if needed
const treeHeight = ref(Math.max(120, window.innerHeight - 200))

function recomputeTreeHeight() {
  treeHeight.value = Math.max(120, window.innerHeight - 200)
}

defineExpose({
  sideVisibleFolderTree,
  openFolderTree,
  geneFolderTree,
  resetSelect,
})

</script>

<style lang="stylus">
.side-tree-modal
  background-color: var(--el-mask-color-extra-light)

  .el-drawer__body
    padding-top: 0

  .folder-search
    margin-bottom: 8px

// floating side bar in the folder tab
.folder-tree-wrap {
  position: relative;
}

.tree-backtop {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 2;
}

.folder-toolbar {
  display: flex; /* ② */
  align-items: center; /* ② */
  gap: 8px;
  margin-bottom: 8px;
}

// collapse expand buttons in the folder tab
.folder-toolbar .folder-search {
  flex: 1; /* input takes remaining width */
}

/* ③ ensure tooltip wrapper aligns like a flex item */
.folder-toolbar .toolbar-tip {
  display: flex;
  align-items: center;
}

.folder-toolbar .el-button.is-circle {
  width: 32px;
  height: 32px;
  padding: 0;

}

.icon-group {
  display: flex;
  align-items: center;
  gap: 0px; /* smaller gap just between the two icons */
  margin-bottom: 10px
  width: 30%
}

// fake "All" row at the top of folder tree
.fake-tree-row {
  display: flex;
  align-items: center;
  height: 28px; /* match :item-size */
  //padding: 0 8px 0 12px;
  width: 100%;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.fake-tree-row:hover {
  background: var(--el-fill-color-light);
}

.fake-tree-row.active {
  background: var(--el-color-primary-light-9);
}

.fake-tree-row__icon {
  margin-right: 6px;
  line-height: 1;
}

.fake-tree-row__label {
  font-size: 14px;
}
</style>