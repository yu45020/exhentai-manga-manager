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
        <el-input
            class="folder-search"
            v-model="treeFilterText"
            placeholder='Search folder'
            clearable
            @input="() => treeRef?.filter?.(treeFilterText)"
            style="flex:1"
        ></el-input>
        <!--        :filter-node-method="filterTreeNode"-->
        <el-tree-v2
            ref="treeRef"
            :data="folderTreeData"
            node-key="folderPath"
            :props="{ value: 'folderPath', label: 'label', children: 'children' }"
            :default-expanded-keys="expandNodes"
            :expand-on-click-node="false"
            :filter-method="filterTreeNode"
            @node-expand="handleNodeExpand"
            @node-collapse="handleNodeCollapse"
            @current-change="selectFolderTreeNode"
            :height="treeHeight"
            :item-size="28"
        ></el-tree-v2>
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
      </el-tab-pane>

    </el-tabs>
  </el-drawer>

</template>

<script setup>

import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useAppStore } from '../pinia.js'

const appStore = useAppStore()

const { setting, bookList, pathSep, folderTreeData, artistTreeData, groupTreeData, parodyTreeData } = storeToRefs(
    appStore)

const activeTreeTab = ref < 'folder' | 'artist' | 'group' > ('folder') // default stays folder
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

const geneFolderTree = async () => {
  const bList = _.filter(_.cloneDeep(bookList.value), book => !book.isCollection)
  const [folderData, { artistList, groupList, parodyList }] = await Promise.all([
    ipcRenderer.invoke('get-folder-tree', bList),
    ipcRenderer.invoke('get-additional-folder-trees'), // returns { name, count }[]
  ])
  folderTreeData.value = folderData
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

const selectFolderTreeNode = async (selectNode) => {
  if (selectNode.folderPath) {
    const clickLibraryPath = setting.value.library + pathSep.value + selectNode.folderPath + pathSep.value
    bookList.value.map(book => book.folderHide = !book.filepath.startsWith(clickLibraryPath))
  } else {
    bookList.value.map(book => book.folderHide = false)
  }
  emit('chunkList')
}

//
const expandNodes = ref([])

onMounted(async () => {
  expandNodes.value = JSON.parse(localStorage.getItem('expandNodes')) || []

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

const handleNodeExpand = (nodeObject) => {
  let expandNodes = JSON.parse(localStorage.getItem('expandNodes')) || []
  expandNodes.push(nodeObject.folderPath)
  expandNodes = [...new Set(expandNodes)]
  localStorage.setItem('expandNodes', JSON.stringify(expandNodes))
}
const handleNodeCollapse = (nodeObject) => {
  let expandNodes = JSON.parse(localStorage.getItem('expandNodes')) || []
  expandNodes = expandNodes.filter(path => !path.includes(nodeObject.folderPath))
  localStorage.setItem('expandNodes', JSON.stringify(expandNodes))
}

const treeFilterText = ref('')
const treeRef = ref()

const _filterTreeNode = (val, data) => {
  if (!val) return true
  return data.label.includes(val)
}

const filterTreeNode = (query, data) => {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true

  const label = String(data?.label ?? '').toLowerCase()
  const folderPath = String(data?.folderPath ?? '').toLowerCase()
  return label.includes(q) || folderPath.includes(q)
}

const resetSelect = () => {
  treeRef.value && treeRef.value.setCurrentKey('')
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
const _filterNode = (value, data) => {
  if (!value) return true
  return (data?.allName ?? '').toLowerCase().includes(value.toLowerCase())
}
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
</style>