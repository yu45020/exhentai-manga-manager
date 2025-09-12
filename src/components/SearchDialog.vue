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

    <div class="hint">
      A single browser window is reused. Switching tabs updates that window.
    </div>

    <template #footer>
      <el-button @click="dialogVisibleEhSearch = false">{{$t('m.close')}}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {computed, nextTick, onMounted, ref, watch} from 'vue'
import {useAppStore} from '../pinia.js'

type TabName = 'e-hentai' | 'exhentai' | 'panda_chaika'

const subWindowId = ref<number | string | null>(null)
const subWindowOpen = ref(false)

const dialogVisibleEhSearch = ref(false)
/* ====== dialog / tabs ====== */
const activeTab = ref<TabName>('e-hentai')

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
  if (typeof api?.onSubWindowClosed === 'function') {
    api.onSubWindowClosed((evt: any) => {
      // match by key or id
      if (evt?.key === SUBWIN_KEY) {
        subWindowOpen.value = false
      }
    })
  }
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

/* ====== public API used by BookDetailDialog.vue’s event ====== */
function openSearchDialog() {
  dialogVisibleEhSearch.value = true
  if (subWindowOpen.value) {
    // pop up the existing browser
    focusExistingPopup()
    return
  }
  // new browser
  nextTick(() => navigateTab(FIRST_TAB))
}

/* When user switches tabs in this dialog, navigate the same popup */
watch(activeTab, (name) => {
  navigateTab(name)
})

/* If settings change while dialog is open, re-inject auth */
watch(() => store.setting, async () => {
  await ensureAuthCookies()
}, {deep: true})

defineExpose({openSearchDialog})
</script>

<style lang="stylus">
.dialog-search
  .el-tabs
    margin-bottom: 8px

.hint
  padding: 8px 0
  color: var(--el-text-color-secondary)
  font-size: 13px
</style>
