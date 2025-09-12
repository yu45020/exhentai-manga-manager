<template>
  <el-dialog
      v-model="dialogVisibleEhSearch"
      width="60vw"
      :title="$t('m.search')"
      destroy-on-close
      class="dialog-search"
  >
    <el-tabs v-model="activeTab">
      <el-tab-pane label="E-Hentai" name="e-hentai"/>
      <el-tab-pane label="ExHentai" name="exhentai"/>
      <el-tab-pane label="Panda Chaika" name="panda_chaika"/>
    </el-tabs>

    <el-form label-position="top" class="ctx-rows">
      <el-form-item :label="$t('m.currentBookTitle') || 'Current book title'">
        <!-- read-only but selectable/copyable (keyboard & right click) -->
        <el-input
            v-model="ctxBookTitle"
            type="textarea"
            :rows="1"
            autosize
            readonly
        />
      </el-form-item>

      <el-form-item :label="$t('m.currentUrl') || 'Current URL'">
        <!-- editable: user can type/paste; value auto-fills for EH/EX tabs -->
        <el-input
            v-model="currentUrl"
            placeholder="https://..."
            clearable,
        />
      </el-form-item>
    </el-form>

    <div class="hint">
      A single browser window is reused. Switching tabs updates that window.
    </div>

    <template #footer>
      <span class="dialog-footer">
        <el-button type="primary" @click="onConfirm">
          {{$t('m.confirm') || 'Confirm'}}
        </el-button>
        <el-button @click="dialogVisibleEhSearch = false">
          {{$t('m.close') || 'Close'}}
        </el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {computed, nextTick, onMounted, ref, watch, reactive, onBeforeUnmount, getCurrentInstance } from 'vue'
import {useAppStore} from '../pinia.js'

// for the text placeholders
const ctxBookTitle = ref<string>('')
const currentUrl = ref<string>('')


function setCurrentUrlFromBrowser(u: string) {
  console.log('setCurrentUrlFromBrowser', u)
  // only accept updates for EH / EX
  try {
    const h = new URL(u).hostname
    const isEH  = /(^|\.)e-hentai\.org$/i.test(h)
    const isEX  = /(^|\.)exhentai\.org$/i.test(h)

    // do not touch the field while Panda Chaika tab is active
    if (activeTab.value === 'panda-chaika') return

    if (isEH || isEX) currentUrl.value = u
  } catch { /* ignore bad URLs */ }
}

const lastUrlBySite = reactive<{ ['e-hentai']: string; ['exhentai']: string }>({
  'e-hentai': '',
  'exhentai': '',
})

// const self = getCurrentInstance()!.exposed as any // has setCurrentUrlFromBrowser
let off: null | (() => void) = null
/*Set up for the browser */
type TabName = 'e-hentai' | 'exhentai' | 'panda_chaika'

const subWindowId = ref<number | string | null>(null)
const subWindowOpen = ref(false)
const dialogVisibleEhSearch = ref(false)
/* ====== dialog / tabs ====== */
// const activeTab = ref<TabName>('e-hentai')
const activeTab = ref<'e-hentai' | 'exhentai' | 'panda-chaika'>('e-hentai')
const TAB_URLS: Record<TabName, string> = {
  'e-hentai': 'https://e-hentai.org/',
  'exhentai': 'https://exhentai.org/',
  'panda_chaika': 'https://panda.chaika.moe/'
}
const FIRST_TAB: TabName = 'e-hentai'

/* ====== single popup identity + session ====== */
const SUBWIN_KEY = 'eh-manual-browser'
const PARTITION = 'persist:eh-search'

/* Use a normal Chrome UA to avoid “Electron” getting challenged */
const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

/* ====== Electron bridge (don’t import 'electron' here) ====== */

const api: any = (window as any).electronAPI || (window as any)

/* ====== Pinia settings (no storeToRefs) ====== */
const store = useAppStore() // state.setting, getter cookie

/* Build dict from state.setting */
const cookieBundle = computed(() => ({
  igneous: (store.setting?.igneous ?? '').trim(),
  ipb_member_id: (store.setting?.ipb_member_id ?? '').trim(),
  ipb_pass_hash: (store.setting?.ipb_pass_hash ?? '').trim(),
  star: (store.setting?.star ?? '').trim(),
}))

/* Ensure cookies are set into the target partition BEFORE loading */
async function ensureAuthCookies() {

  const c = cookieBundle.value
  const hasAny = c.igneous || c.ipb_member_id || c.ipb_pass_hash || c.star
  if (!hasAny) return

  // If your preload/main exposes an explicit setter, use it.
  if (typeof api.setEhCookies === 'function') {
    await api.setEhCookies({
      partition: PARTITION,
      cookies: c,
      cookieHeader: store.cookie || '',
      domains: ['exhentai.org', 'e-hentai.org'],
      expirationSeconds: 60 * 60 * 24 * 365
    })
  }
}


onMounted(() => {
  // (1) handle subwindow close notifications (optional)
  if (typeof api?.onSubWindowClosed === 'function') {
    api.onSubWindowClosed((evt: any) => {
      if (evt?.key === SUBWIN_KEY) {
        subWindowOpen.value = false
      }
    })
  }
if (window?.electron?.onCurrentUrl) {
    off = window.electron.onCurrentUrl((url: string) => setCurrentUrlFromBrowser(url))
  }
})

onBeforeUnmount(() => {
  off?.()
  off = null
})

async function focusExistingPopup() {
  if (!subWindowOpen.value) return
  try {
    await api.focusSubWindow?.({id: subWindowId.value, key: SUBWIN_KEY})
  } catch { /* ignore */
  }
}


async function navigateTab(name: TabName) {
  await ensureAuthCookies()
  subWindowId.value = await api.createSubWindow({
    key: SUBWIN_KEY,
    url: TAB_URLS[name],
    title: 'Manual Metadata',
    width: 1100,
    height: 800,
    reuse: true,                   // focus & load if already open
    partition: PARTITION,          // persistent session for cookies
    userAgent: CHROME_UA,          // ← important for Cloudflare / anti-bot
    cookies: cookieBundle.value,   // fallback path for main to set cookies
    cookieHeader: store.cookie || ''
  })
  subWindowOpen.value = true
}

// Helper: decide if URL belongs to EH/EX
function isEhHost(u: string): boolean {
  try {
    const h = new URL(u).hostname
    return /(^|\.)e-hentai\.org$/i.test(h) || /(^|\.)exhentai\.org$/i.test(h)
  } catch {
    return false
  }
}

/* ====== public API used by BookDetailDialog.vue’s event ====== */

// Extend your existing openSearchDialog to accept title/url payload
function openSearchDialog(payload?: { title?: string; url?: string }) {
  dialogVisibleEhSearch.value = true

  if (payload?.title) {
    ctxBookTitle.value = payload.title
  }
  if (payload?.url && isEhHost(payload.url)) {
    const key = payload.url.includes('exhentai.org') ? 'exhentai' : 'e-hentai'
    lastUrlBySite[key] = payload.url
    if (activeTab.value === key) currentUrl.value = payload.url
  }


  if (subWindowOpen.value) {
    // pop up the existing browser
    focusExistingPopup()
    return
  }
  // new browser
  nextTick(() => navigateTab(FIRST_TAB))
}

// Confirm → emit values upward, then close
const emit = defineEmits<{
  (e: 'confirm', payload: { activeTab: string; title: string; url: string }): void
}>()

function onConfirm() {
  setBrowserUrl(currentUrl.value) // remember if EH/EX
  emit('confirm', {
    activeTab: String(activeTab.value),
    title: ctxBookTitle.value,
    url: currentUrl.value,
  })
  dialogVisibleEhSearch.value = false
}


// Exposed to parent or internal browser-bridge code: whenever your subwindow navigates,
// call setBrowserUrl(currentUrl). This will update the remembered URL and the input
// IF the current tab is the matching site.
function setBrowserUrl(url: string) {
  if (!isEhHost(url)) return
  const key = url.includes('exhentai.org') ? 'exhentai' : 'e-hentai'
  lastUrlBySite[key] = url
  if (activeTab.value === key) currentUrl.value = url
}


/* When user switches tabs in this dialog, navigate the same popup */
watch(activeTab, (name) => {
  navigateTab(name)
  if (newTab === 'e-hentai' || newTab === 'exhentai') {
    if (lastUrlBySite[newTab]) currentUrl.value = lastUrlBySite[newTab]
  }
})

/* If settings change while dialog is open, re-inject auth */
watch(() => store.setting, async () => {
  await ensureAuthCookies()
}, {deep: true})



defineExpose({openSearchDialog, setBrowserUrl, setCurrentUrlFromBrowser })
</script>

<style lang="stylus">
.dialog-search
  .el-tabs
    margin-bottom: 8px

.hint
  padding: 8px 0
  color: var(--el-text-color-secondary)
  font-size: 13px

.ctx-rows
  margin-top: 8px
  margin-bottom: 8px

.dialog-footer
  display: inline-flex
  gap: 8px
</style>
