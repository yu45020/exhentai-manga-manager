<template>
  <el-dialog
      class="search-dialog"
      v-model="dialogVisible"
      :title="$t('m.searchMetadata') || 'Search Metadata'"
      width="90%"
      top="5vh"
      :destroy-on-close="true"
      :close-on-press-escape="true"
      :close-on-click-modal="true"
      @opened="onDialogOpened"
      :before-close="handleBeforeClose"
      @closed="onDialogClosed"
      @close="dialogVisible = false"
  >
    <!-- Tabs -->
    <div class="topbar">
      <el-tabs v-model="activeTab" class="topbar-tabs">
        <el-tab-pane name="e-hentai" label="E-Hentai"/>
        <el-tab-pane name="exhentai" label="ExHentai"/>
        <el-tab-pane name="nhentai" label="NHentai"/>
        <el-tab-pane name="hentag" label="Hentag"/>
        <el-tab-pane name="panda-chaika" label="Panda Chaika"/>
      </el-tabs>
    </div>

    <!-- Context rows -->
    <el-form label-position="top" class="ctx-rows">
      <!-- Row 1: Current book title (read-only but selectable) -->
      <el-form-item :label="$t('m.currentBookTitle') || 'Current book title'">
        <el-input
            v-model="ctxBookTitle"
            type="textarea"
            :rows="1"
            autosize
            readonly
            spellcheck="false"
        />
      </el-form-item>

      <!-- Row 2: Current URL (editable) and Confirm Button -->
      <el-form-item class="current-url-item">
        <template #label>
          <div class="label-row">
            <span>{{ $t('m.currentUrl') || 'Current Source URL' }}</span>
            <el-button
                type="primary"
                size="small"
                :disabled="!canConfirm"
                native-type="button"
                @click="onConfirm"
            >
              {{ $t('m.confirm') || 'Confirm' }}
            </el-button>
            <el-button
                type="primary"
                size="small"
                native-type="button"
                :disabled="!canConfirmPartialUpdate"
                @click="onConfirmPartialUpdate"
            >
              {{ $t('m.partialUpdate') || 'partialUpdate' }}
            </el-button>
          </div>
        </template>
        <div class="nav-row">
          <div class="nav-buttons">
            <el-button
                class="nav-btn"
                :class="{ 'is-available': navState.canBack }"
                circle
                :disabled="!navState.canBack"
                aria-label="Back"
                @click="nav('back')">
              <el-icon class="nav-icon">
                <ArrowLeft/>
              </el-icon>
            </el-button>
            <el-button
                class="nav-btn"
                :class="{ 'is-available': navState.canFwd }"
                circle
                :disabled="!navState.canFwd"
                aria-label="Forward"
                @click="nav('forward')">
              <el-icon class="nav-icon">
                <ArrowRight/>
              </el-icon>
            </el-button>
          </div>
          <form id="search-url-form" @submit.prevent.stop class="url-form">
            <el-input
                v-model="navState.url"
                class="url-input"
                placeholder="https://..."
                clearable
                spellcheck="false"
                @keyup.enter.stop.prevent
                @keydown.enter.stop.prevent
                @focus="isEditingUrl = true"
                @blur="isEditingUrl = false"
            />
          </form>
        </div>
      </el-form-item>
    </el-form>

    <!-- Embedded browser under the second row -->
    <div class="webview-wrap" v-if="dialogVisible"> <!-- tie lifetime to visibility -->
      <div ref="webviewHost" tabindex="0" class="webview-el"></div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
/** Search related ipc and shortcuts are in ./index.js, search keyword "for sub browser" there
 */
import {computed, nextTick, onBeforeUnmount, ref, watch, reactive} from 'vue'
import {ArrowLeft, ArrowRight} from '@element-plus/icons-vue'

const id = 'search-dialog' // browser id
type TabKey = 'e-hentai' | 'exhentai' | 'nhentai' | 'hentag' | 'panda-chaika'

type Unsub = () => void
let offNavigate: Unsub | null = null
let offNavigateInPage: Unsub | null = null
let offNavState: null | (() => void) = null

let teardown: Unsub | null = null
// navigation state
const nav = (dir: 'back' | 'forward') => window.wcv.nav(id, dir)
const navState = reactive({url: '', canBack: false, canFwd: false})
const isEditingUrl = ref(false)


function applyState(s: any) {
  if (!s || s.id !== id) return
  if (!isEditingUrl.value && s.url) navState.url = s.url  // <-- don't overwrite while editing
  navState.canBack = !!s.canBack
  navState.canFwd = !!s.canFwd
}


function bindIpc() {
  const setUrl = (_e: any, data: any) => {
    navState.url = data?.url ?? ''
  }
  // guard to avoid double-binding on re-open
  if (!offNavigate) offNavigate = window.ipcRenderer.ipcOn('wcv:did-navigate', setUrl)
  if (!offNavigateInPage) offNavigateInPage = window.ipcRenderer.ipcOn('wcv:did-navigate-in-page', setUrl)
  if (!offNavState) offNavState = window.wcv.onState(applyState)

}

function unbindIpc() {
  offNavigate?.()
  offNavigate = null
  offNavigateInPage?.()
  offNavigateInPage = null
  offNavState?.();
  offNavState = null
}

/** ===== Props & Emits (keeps backward compatibility) ===== */
const props = withDefaults(defineProps<{
  /** Control visibility via v-model:visible (optional) */
  visible?: boolean
  /** Prefill the title row */
  bookTitle?: string
  /** title removed [] and () */
  cleanTitle?: string
  /** Prefill the URL if it’s EH/EX */
  initialUrl?: string
  /** Initial active tab */
  startTab?: TabKey
  /** Persistent session for cookies/login */
  partition?: string
  /** Custom UA (optional) */
  userAgent?: string
}>(), {
  visible: false,
  bookTitle: '',
  initialUrl: 'https://e-hentai.org/',
  startTab: 'e-hentai',
  partition: 'persist:eh-search',
  userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
})

const emit = defineEmits<{
  (e: 'confirm', payload: { bookDetail, url: string }): void
  (e: 'confirmPartialUpdate', payload: { bookDetail, url: string, wcId, }): void
  (e: 'update:visible', value: boolean): void
}>()

/** ===== State ===== */
// Two-way proxy
const dialogVisible = computed({
  get: () => props.visible,
  set: v => emit('update:visible', v),
})
// const dialogVisible = ref<boolean>(props.visible)
// watch(() => props.visible, v => (dialogVisible.value = v))

const activeTab = ref<TabKey>(props.startTab)
const ctxBookTitle = ref<string>(props.bookTitle)
const cleanTitle = ref<string>(props.cleanTitle)


/** Electron <webview> element ref (typed as any to avoid Electron TS deps) */
const webviewHost = ref<HTMLElement | null>(null)


/** ---------- Attach / detach listeners WHEN dialog content is actually in DOM ---------- */
// --- Keep WebContentsView aligned with the host <div> ---
async function onDialogOpened() {
  await nextTick()
  const host = webviewHost.value
  if (!host) return

  // Clean up any previous listeners/view
  // onDialogClosed()
  bindIpc()

  const state = await window.wcv.getState(id)
  if (state) applyState(state)

  const rect = host.getBoundingClientRect()
  const bounds = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }

  // Attach / create WebContentsView at these bounds
  try {
    const payload = {
      id,
      bounds,
      partition,
      userAgent,
      url: navState.url // the initial url is the site url + query string, updated in openSearchDialog
    }

    window.ipcRenderer.invoke('wcv:attach', payload)
  } catch (err) {
    console.error('wcv attach failed:', err)
  }

  startFollowHost(id)

  teardown = () => {
    unbindIpc()
  }
}

const isDetaching = ref(false)

function handleBeforeClose(done: () => void) {
  stopFollowHost()
  if (isDetaching.value) {
    done();
    return
  }
  isDetaching.value = true

  teardown?.()
  teardown = null

  // visually hide *immediately* so the user never sees the stale frame
  if (webviewHost.value) {
    webviewHost.value.style.visibility = 'hidden'   // instant
  }

  // fire-and-forget detach (we don't need to await the promise to proceed)
  window.ipcRenderer.invoke('wcv:detach', id)

  // proceed with dialog’s own closing animation
  done()

  // let later hooks run without double-detach
  queueMicrotask(() => {
    isDetaching.value = false
  })
}

function onDialogClosed() {
  teardown?.()
  teardown = null
  stopFollowHost()
  window.ipcRenderer.invoke('wcv:detach', id)
}

/* == helpers for resize == */
// don't use requestAnimationFrame (rAF) here
let lastBounds = {x: -1, y: -1, width: -1, height: -1}
let cleanupFollow: Unsub | null = null
let scheduled = false

function computeBounds(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }
}

function boundsChanged(a: typeof lastBounds, b: typeof lastBounds) {
  return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height
}

function sendSetBounds(id: string, b: typeof lastBounds) {
  window.ipcRenderer.invoke('wcv:set-bounds', {id: id, bounds: b})
}

function findScrollParents(el: HTMLElement) {
  const out: HTMLElement[] = []
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.body) {
    const s = getComputedStyle(node)
    const hasScroll =
        /(auto|scroll|overlay)/.test(s.overflow + s.overflowY + s.overflowX)
    if (hasScroll) out.push(node)
    node = node.parentElement
  }
  return out
}

function scheduleSync(id: string) {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    const host = webviewHost.value
    if (!host) return
    const b = computeBounds(host)
    if (boundsChanged(lastBounds, b)) sendSetBounds(id, b)
  })
}

function startFollowHost(id: string) {
  if (cleanupFollow) return
  const host = webviewHost.value
  if (!host) return

  // Observe size changes of the host
  const ro = new ResizeObserver(() => scheduleSync(id))
  ro.observe(host)

  // Listen to window scroll/resize
  const onWinScroll = () => scheduleSync(id)
  const onWinResize = () => scheduleSync(id)
  window.addEventListener('scroll', onWinScroll, {passive: true, capture: true})
  window.addEventListener('resize', onWinResize, {passive: true})

  // Also listen to scrollable ancestors so inner container scrolling is tracked
  const parents = findScrollParents(host)
  const onParentScroll = () => scheduleSync(id)
  parents.forEach(p => p.addEventListener('scroll', onParentScroll, {passive: true}))

  // Initial sync
  scheduleSync(id)

  // Cleanup function
  cleanupFollow = () => {
    try {
      ro.disconnect()
    } catch {
    }
    window.removeEventListener('scroll', onWinScroll, {capture: true} as any)
    window.removeEventListener('resize', onWinResize)
    parents.forEach(p => p.removeEventListener('scroll', onParentScroll))
    cleanupFollow = null
  }
}

function stopFollowHost() {
  cleanupFollow?.()
}

/** Pick a default URL based on current tab */

onBeforeUnmount(() => {
  emit('update:visible', false)
  onDialogClosed()
})

/* ======= Clean book title for initial search =================*/
function cleanBookTitle(filename: string): [string, string] {
  function stripDirs(s: string): string {
    // Remove path portion if any (Windows or POSIX)
    return s.replace(/^.*[\\/]/, '');
  }

  function stripExtension(s: string): string {
    // Remove the last extension only: foo.bar.baz -> foo.bar
    return s.replace(/\.[^.]+$/, '');
  }

  function removeBracketed(s: string, pairs: Array<[string, string]>): string {
    let out = s;
    for (const [open, close] of pairs) {
      // Non-greedy across any chars (including newlines)
      const re = new RegExp(`${open}[\\s\\S]*?${close}`, 'g');
      out = out.replace(re, '');
    }
    return out;
  }

  function normalizeWhitespace(s: string): string {
    // Convert underscores/dots to spaces, collapse spaces, trim
    return s
        .replace(/[_·•]+/g, ' ')
        .replace(/[.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
  }

  const base = stripDirs(stripExtension(filename)).trim()
  let cleaned = normalizeWhitespace(removeBracketed(base, [
    // the round
    ['\\(', '\\)'], ['（', '）'],
    // square
    ['\\[', '\\]'], ['［', '］'], ['【', '】'],
  ]));
  if (!cleaned) {
    // Second pass: remove only square-bracket content (incl. Japanese)
    cleaned = normalizeWhitespace(removeBracketed(base, [
      ['\\[', '\\]'], ['［', '］'], ['【', '】'],
    ]))
  }

  // Final fallback: just use the base (no extension)
  return [base, cleaned]
}

function buildInitialSearchUrl(tab, query) {
  let queryUrl
  const keyword = encodeURI(query)
  switch (tab) {
    case 'e-hentai':
      queryUrl = `https://e-hentai.org/?f_search=${keyword}&f_cats=161`
      break
    case 'exhentai':
      queryUrl = `https://exhentai.org/?f_search=${keyword}&f_cats=161`
      break
    case 'hentag':
      queryUrl = `https://hentag.com/?t=${keyword}`
      break
    case 'nhentai':
      queryUrl = `https://nhentai.net/search/?q=${keyword}`
      break
    case 'panda-chaika':
      queryUrl = `https://panda.chaika.moe/search?title=${keyword}`
      break
  }
  return queryUrl
}

/** ===== Reactions ===== */
/** When tab changes, switch the webview to the site’s home. */
watch(activeTab, (t) => {
  const url = buildInitialSearchUrl(t, cleanTitle.value)
  window.ipcRenderer.invoke('wcv:loadURL', {id, url})
})

/** Confirm -> emit and close
 * The data is sent back to the SearchDialog parent component to grab tags
 * */
async function onConfirm() {
  if (!canConfirm.value) return
  await nextTick()
  emit('confirm', {bookDetail: bookDetail, url: navState.url.trim()})
  dialogVisible.value = false
  // onDialogClosed()
}

async function onConfirmPartialUpdate() {
  if (!canConfirmPartialUpdate.value) return
  await nextTick()
  emit('confirmPartialUpdate', {bookDetail: bookDetail, url: navState.url.trim(), wcId: id})
  // dialogVisible.value = false // is closed by parent
}

// helpers for confirm button
const canConfirm = computed(() => isGalleryUrl(navState.url))
const canConfirmPartialUpdate = computed(() => isGalleryUrl(navState.url, true))

const EH_HOSTS = new Set(['e-hentai.org', 'exhentai.org'])
const NHENTAI_HOST = 'nhentai.net'
const HENTAG_HOST = 'hentag.com'

const EH_GALLERY_RE = /^\/g\/(?<gid>\d+)\/(?<token>[A-Za-z0-9_-]+)(?:\/|$)/
const NH_GALLERY_RE = /^\/g\/(?<gid>\d+)(?:\/|$)/

const normalizeHost = (h: string) => h.toLowerCase().replace(/^www\./, '')

function isGalleryUrl(u: string, partial = false): boolean {
  try {
    const {hostname, pathname} = new URL(u)
    const host = normalizeHost(hostname)
    if (EH_HOSTS.has(host)) return EH_GALLERY_RE.test(pathname)
    if (host === NHENTAI_HOST) return NH_GALLERY_RE.test(pathname)
    if (partial) return false // only support ex/eh/nhentai for partial update
    if (host === HENTAG_HOST) return pathname.startsWith('/vault/')
    return false
  } catch {
    return false
  }
}


/** ===== Optional: external open API for compatibility ===== */
// the initial url is the site url + query string
let bookDetail = null

async function openSearchDialogBrowser(book) {

  [ctxBookTitle.value, cleanTitle.value] = cleanBookTitle(book.filepath)
  activeTab.value = props.startTab
  navState.url = buildInitialSearchUrl(activeTab.value, cleanTitle.value)
  dialogVisible.value = true
  bookDetail = book
}

/** Expose the open function for external use */
defineExpose({openSearchDialogBrowser})
/** ===== Pass-throughs for <webview> attributes ===== */
const partition = props.partition
const userAgent = props.userAgent
</script>

<style lang="stylus" scoped>
.search-dialog
  :deep(.el-dialog)
    height: 90vh
    display: flex
    flex-direction: column

  :deep(.el-dialog__body)
    flex: 1
    display: flex
    flex-direction: column
    overflow: hidden

/* prevents double scrollbars */
/* Top bar with tabs and actions aligned on one row */
.topbar
  display: flex
  align-items: center
  gap: 12px
  margin-bottom: 8px

/* Let tabs take remaining space; remove default bottom margin */
.topbar-tabs
  flex: 1
  min-width: 0

  :deep(.el-tabs__header)
    margin: 0

/* Buttons flush right, consistent spacing */
.topbar-actions
  margin-left: auto
  display: inline-flex
  gap: 8px

.current-url-item :deep(.el-form-item__label)
  width: 100%

.label-row
  display: flex
  align-items: center
  justify-content: space-between
  gap: 8px

.ctx-rows
  margin-top: 4px
  margin-bottom: 8px

.webview-wrap
  flex: 1
  min-height: 60vh
  display: flex
  margin-top: 8px
  min-width: 0 /* fixes flex overflow in some browsers */
  flex-direction: column

.webview-el
  flex: 1
  width: 100%
  height: 100% /* fill the wrapper */
  border: 1px solid var(--el-border-color)

.dialog-footer
  display: inline-flex
  gap: 8px

/* Make enabled buttons pop; disabled look muted */
.nav-row
  display: flex
  align-items: center
  gap: 8px
  width: 100%
  min-width: 0

.nav-buttons
  display: flex
  gap: 4px
  margin-inline-end: 16px

.nav-btn :deep(.el-icon svg)
  stroke-width: 4.2
  font-size: 38px

.nav-btn {
  opacity: 0.35;
  transition: opacity .15s ease, transform .06s ease, box-shadow .15s ease;
}

.nav-btn.is-available {
  opacity: 1;
  box-shadow: 0 0 0 2px rgba(64, 158, 255, .15); /* subtle ring */
}

.nav-btn.is-available:hover {
  transform: translateY(-1px);
  box-shadow: 0 0 0 2px rgba(64, 158, 255, .30);
}

.nav-icon
  font-size: 18px // slightly larger
  color: currentColor

/* increase stroke thickness on the SVG */
.nav-icon :deep(svg)
  stroke-width: 2.2

/* URL input fills remaining space */
.url-form
  flex: 1 1 auto
  min-width: 0
  display: block

.url-input
  display: flex
  align-items: center
  justify-content: space-between
  gap: 8px
  min-width: 0
  width: 100%


.nav-btn.is-available {
  opacity: 1;
}

.nav-btn:not(.is-available) {
  opacity: 0.35;
}
</style>
