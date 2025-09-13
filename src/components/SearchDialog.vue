<template>
  <el-dialog
      class="search-dialog"
      :model-value="dialogVisible"
      :title="$t('m.searchMetadata') || 'Search Metadata'"
      width="90%"
      top="5vh"
      :destroy-on-close="true"
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

      <!-- Row 2: Current URL (editable) -->
      <el-form-item class="current-url-item">
        <template #label>
          <div class="label-row">
            <span>{{$t('m.currentUrl') || 'Current Source URL'}}</span>
            <el-button type="primary" size="small" @click="onConfirm">
              {{$t('m.confirm') || 'Confirm'}}
            </el-button>
          </div>
        </template>
        <el-input
            v-model="currentUrl"
            placeholder="https://..."
            clearable
            spellcheck="false"
        />
      </el-form-item>
    </el-form>

    <!-- Embedded browser under the second row -->
    <div class="webview-wrap">
      <div ref="webviewHost" tabindex="0" class="webview-el"></div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue'

const {invoke, on} = window.electron

const id = 'search-dialog' // browser id
type TabKey = 'e-hentai' | 'exhentai' | 'panda-chaika'

const TabUrl = {
  'e-hentai': 'https://e-hentai.org/',
  'exhentai': 'https://exhentai.org/',
  'panda-chaika': 'https://panda.chaika.moe/'
}
const TabUrlInitSearch = {
  'e-hentai': 'https://e-hentai.org/?f_search=',
  'exhentai': 'https://exhentai.org/?f_search=',
  'panda-chaika': 'https://panda.chaika.moe/search?title='
}

type Unsub = () => void
let offNavigate: Unsub | null = null
let offNavigateInPage: Unsub | null = null
let teardown: Unsub | null = null

// keep track of the current url
const onDidNavigate = (_e: any, data: any) => setCurrentUrlFromBrowser(data?.url || '')
const onInPage = (_e: any, data: any) => setCurrentUrlFromBrowser(data?.url || '')

function bindIpc() {
  // guard to avoid double-binding on re-open
  if (!offNavigate) {
    offNavigate = on('wcv:did-navigate', onDidNavigate)
  }
  if (!offNavigateInPage) {
    offNavigateInPage = on('wcv:did-navigate-in-page', onInPage)
  }
}

function unbindIpc() {
  offNavigate?.()
  offNavigate = null
  offNavigateInPage?.()
  offNavigateInPage = null
}

/** ===== Props & Emits (keeps backward compatibility) ===== */
const props = withDefaults(defineProps<{
  /** Control visibility via v-model:visible (optional) */
  visible?: boolean
  /** Prefill the title row */
  bookTitle?: string
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
  // (e: 'update:visible', v: boolean): void
  (e: 'confirm', payload: { activeTab: TabKey; title: string; url: string }): void
}>()

/** ===== State ===== */
const dialogVisible = ref<boolean>(props.visible)
watch(() => props.visible, v => (dialogVisible.value = v))
// watch(dialogVisible, v => emit('update:visible', v))

const activeTab = ref<TabKey>(props.startTab)
const ctxBookTitle = ref<string>(props.bookTitle)
const currentUrl = ref<string>('')
const cleanTitle = ref<string>('')


/** Electron <webview> element ref (typed as any to avoid Electron TS deps) */
const webviewHost = ref<HTMLElement | null>(null)

/** ===== Helpers ===== */
function isEhOrEx(u: string): boolean {
  try {
    const h = new URL(u).hostname
    return /(^|\.)e-hentai\.org$/i.test(h) || /(^|\.)exhentai\.org$/i.test(h)
  } catch {
    return false
  }
}

/** Only update the 2nd row for EH/EX and not when Panda tab is selected */
function setCurrentUrlFromBrowser(u: string) {
  currentUrl.value = u
  // if (activeTab.value === 'panda-chaika') return
  // if (isEhOrEx(u)) currentUrl.value = u
}

/** Navigate the webview safely */
function navigateWebviewTo(url: string) {
  invoke('wcv:loadURL', {id, url})
}

/** ---------- Attach / detach listeners WHEN dialog content is actually in DOM ---------- */
// --- Keep WebContentsView aligned with the host <div> ---
async function onDialogOpened() {
  await nextTick()
  const host = webviewHost.value
  if (!host) return

  // Clean up any previous listeners/view
  onDialogClosed()
  bindIpc()
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
      url: currentUrl.value
    }

    invoke('wcv:attach', payload)
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
  invoke('wcv:detach', id)

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
  invoke('wcv:detach', id)
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
  invoke('wcv:set-bounds', {id: id, bounds: b})
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
// const defaultSrcForTab = computed(() => {
//   return TabUrl[activeTab.value]
// })

onBeforeUnmount(() => {
  teardown?.()
  teardown = null
})

/* ======= Clean book title for initial search =================*/
function cleanBookTitle(filename: string) {
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
    // round
    ['\\(', '\\)'], ['（', '）'],
    // square
    ['\\[', '\\]'], ['［', '］'], ['【', '】'],
  ]));

  if (!cleaned) {
    // Second pass: remove only square-bracket content (incl. Japanese)
    cleaned = normalizeWhitespace(removeBracketed(base, [
      ['\\[', '\\]'], ['［', '］'], ['【', '】'],
    ]));
  }

  // Final fallback: just use the base (no extension)
  return encodeURIComponent(cleaned || base)
}

// function buildInitialSearchUrl(tab, title) {
//   const query = cleanBookTitle(title)
//   return TabUrlInitSearch[tab] +  encodeURIComponent(query)
// }

/** ===== Reactions ===== */
/** When tab changes, switch the webview to the site’s home. */
watch(activeTab, (t) => {
  navigateWebviewTo(TabUrlInitSearch[t]  + cleanTitle.value)
})

/** Confirm -> emit and close */
function onConfirm() {
  emit('confirm', {
    activeTab: activeTab.value,
    title: ctxBookTitle.value,
    url: currentUrl.value
  })
  dialogVisible.value = false
}


/** ===== Optional: external open API for compatibility ===== */
function openSearchDialog(payload?: { title?: string; url?: string; }) {
  ctxBookTitle.value = payload.title
  activeTab.value = props.startTab
  cleanTitle.value = cleanBookTitle(ctxBookTitle.value)
  currentUrl.value = TabUrlInitSearch[activeTab.value] + cleanTitle.value
  dialogVisible.value = true
}

/** Expose the open function for external use */
defineExpose({openSearchDialog})
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
  width: 50%

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
  min-height: 60vh /* your predefined height baseline */
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
</style>
