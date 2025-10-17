<!-- ./src/components/VerifyFuzzyMatch.vue -->
<template>
  <el-dialog
      :title="`${t('m.verifyFuzzyMatches')}`"
      v-model="visibleProxy"
      class="vfm-dialog"
      top="5vh"
      width="88%"
      append-to-body
      destroy-on-close
  >
    <!-- Toggle: All / Selected / Unselected (right below header) -->
    <div class="vfm-header-tools">
      <el-radio-group v-model="filterMode" size="small">
        <el-radio-button label="all">{{t('m.all')}}</el-radio-button>
        <el-radio-button label="selected">{{t('m.selected')}}</el-radio-button>
        <el-radio-button label="unselected">{{t('m.unselected')}}</el-radio-button>

      </el-radio-group>
      <div class="spacer"></div>
    </div>

    <!-- Main split -->
    <div class="vfm-main">
      <!-- Left: table -->
      <div class="vfm-left">
        <el-table
            ref="tableRef"
            :data="pagedRows"
            height="56vh"
            highlight-current-row
            row-key="__rowKey"
            @row-click="onRowClick"
            class="vfm-table"
        >
          <!-- Selection -->
          <el-table-column width="52" align="center">
            <template #header>
              <el-checkbox
                  :indeterminate="isIndeterminate"
                  :model-value="isAllVisibleSelected"
                  @change="toggleSelectAllVisible"
              />
            </template>
            <template #default="{ row }">
              <el-checkbox
                  :model-value="selectedIds.has(row.id)"
                  @change="val => toggleRow(row, val)"
              />
            </template>
          </el-table-column>

          <!-- Stacked title: basename(filepath), title_jpn, title -->
          <el-table-column :label="t('m.stackedTitle')" min-width="480" class-name="col-stacked">
            <template #default="{ row }">
              <div class="stacked-cell two-lines">
                <div class="file-line" :title="row.basename">
                  <span class="mono filename-wrap">{{row.basename}}</span>
                </div>
                <!-- Highlight differences relative to filename -->
                <div class="title-line"
                     v-html="row.bestTitleHtml"
                     :title="row.bestTitleRaw">
                </div>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <!-- Pager (optional) -->
        <div class="vfm-pager" v-if="pageCount > 1">
          <el-pagination
              layout="prev, pager, next, jumper"
              :total="filteredRows.length"
              :page-size="pageSize"
              v-model:current-page="page"
              small
          />
        </div>
      </div>

      <!-- Right: preview -->
      <div class="vfm-right">
        <el-card shadow="never" class="vfm-card">
          <!-- Cover -->
          <div class="cover-box">
            <div v-if="!focusedRow" class="cover-empty">
              <span>{{t('m.selectARowToPreview')}}</span>
            </div>
            <el-image
                v-else
                :src="focusedRow.coverPath || ''"
                :preview-src-list="focusedRow?.coverPath ? [focusedRow.coverPath] : []"
                :initial-index="0"
                fit="contain"
                :z-index="4000"
                :preview-teleported="true"
                hide-on-click-modal
                class="cover-img"
            />
          </div>

          <!-- Meta lines -->
          <div class="meta">
            <div class="meta-row">
              <label>artists</label>
              <div class="ellipsis" :title="focusedRow?.artists">{{focusedRow?.artists || '—'}}</div>
            </div>
            <div class="meta-row">
              <label>group</label>
              <div class="ellipsis" :title="focusedRow?.group">{{focusedRow?.group || '—'}}</div>
            </div>
            <div class="meta-row">
              <label>parody</label>
              <div class="ellipsis" :title="focusedRow?.parody">{{focusedRow?.parody || '—'}}</div>
            </div>
          </div>

          <!-- Row actions -->
          <div class="row-actions">
            <el-button
                v-if="focusedRow"
                type="primary"
                size="small"
                @click="acceptOne(focusedRow)"
            >
              {{t('m.acceptThis')}}
            </el-button>
            <el-button
                v-if="focusedRow"
                size="small"
                @click="rejectOne(focusedRow)"
            >
              {{t('m.skipThis')}}
            </el-button>
            <el-button
                v-if="focusedRow"
                size="small"
                @click="revealInFolder(focusedRow)"
                :disabled="!canRevealInFolder"
            >
              {{t('m.revealInFolder')}}
            </el-button>
          </div>

        </el-card>
      </div>
    </div>

    <!-- Footer actions -->
    <template #footer>
      <div class="vfm-footer">
        <div class="left">
          <span>{{t('m.selected')}}: {{selectedIds.size}}</span>
          <span class="sep">·</span>
          <span>{{t('m.showing')}}: {{filteredRows.length}}</span>
        </div>
        <div class="right">
          <el-button
              :disabled="selectedIds.size === 0"
              @click="resetSelected"
          >
            {{t('m.resetSelected')}}
          </el-button>
          <el-button
              type="primary"
              :disabled="selectedIds.size === 0"
              :loading="bulkBusy"
              @click="acceptSelected"
          >
            {{t('m.acceptSelected')}}
          </el-button>
          <!--More ▾ dropdown-->
          <el-dropdown trigger="click">
            <el-button text>
              {{t('m.more')}}
              <el-icon class="ml-4">
                <ArrowDown/>
              </el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                    :disabled="selectedIds.size === 0"
                    @click="onClearMetadataSelected"
                >
                  {{t('m.clearMetadataForSelected')}}
                </el-dropdown-item>
                <el-dropdown-item
                    :disabled="!canUndoAccept"
                    @click="undoLastAccept"
                >
                  {{t('m.undoLastAccept')}}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </template>
  </el-dialog>

</template>

<script setup lang="js">
import { computed, defineEmits, defineExpose, defineProps, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../pinia.js'
import { storeToRefs } from 'pinia'
import { useTranslationDict } from '../composables/useTranslationDict'

const { translateArtist, translateGroup, translateParody, ensureLoaded } = useTranslationDict()
ensureLoaded()

const tableRef = ref(null)
const props = defineProps({
  visible: { type: Boolean, default: false },
  pageSize: { type: Number, default: 200 },
})
const emit = defineEmits([
  'update:visible',
])
const { t } = useI18n()

// app state
const appStore = useAppStore()
const { bookList } = storeToRefs(appStore)
const { saveBook, resetMetadata } = appStore
// visibility
const innerVisible = ref(false)

const visibleProxy = computed({
  get: () => props.visible ?? innerVisible.value,
  set: v => {
    innerVisible.value = v
    emit('update:visible', v)
  }
})

function open() { visibleProxy.value = true }

function close() { visibleProxy.value = false }

defineExpose({ open, close })

// toggle: all / selected / unselected
const filterMode = ref('all')

// helpers
function baseName(p) {
  if (!p) return ''
  // handle both \ and / separators
  const parts = String(p).split(/[/\\]+/)
  return parts[parts.length - 1] || ''
}

// Compose rows from books with status === 'need-verify'
const baseRows = computed(() => {
  const rows = (bookList.value || [])
      .filter(b => b && b.status === 'need-verify')
      .map((b, idx) => {
        const filepath = b.filepath || ''
        const basename = baseName(b.filepath || '')
        const tJ = b.title_jpn || ''
        const tN = b.title || ''
        const best = pickBestTitle(basename, tJ, tN)
        const bestHtml = highlightDiffAgainstFilename(best, basename)


        return {
          __rowKey: `${b.id ?? b.idx ?? idx}`,
          id: b.id,
          filepath,
          basename,
          title_jpn: b.title_jpn || b.title_jpn || '',
          title: b.title || '',
          bestTitleRaw: best,
          bestTitleHtml: bestHtml,
          artists: translateArtist.value(b?.tags?.artist),
          group: translateGroup.value(b?.tags?.group),
          parody: translateParody.value(b?.tags?.parody),
          coverPath: b.coverPath || '',
          __raw: b,
        }
      })
  return rows
})


const bookById = computed(() => new Map(bookList.value.map(b => [b.id, b])))


/* --- helpers for similarity + diff-highlight (lowercase only to preserve indices) --- */
function lcsIndices(a, b) {
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]
    }
  }
  // backtrack to get indices in b that are part of LCS
  const idxB = []
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      idxB.push(j - 1)
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--
    else j--
  }
  return new Set(idxB.reverse())
}

function similarityByLCS(a, b) {
  const n = a.length, m = b.length
  if (!n || !m) return 0
  // compute LCS length only (reuse dp but no backtrack)
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]
    }
  }
  const lcsLen = dp[n][m]
  return lcsLen / Math.max(n, m)
}

function highlightDiffAgainstFilename(candidate, filename) {
  const cand = String(candidate || '')
  const fn = String(filename || '')
  const a = fn.toLowerCase()
  const b = cand.toLowerCase()
  if (!cand) return '—'
  const inLCS = lcsIndices(a, b) // positions in candidate that match filename via LCS

  // Build HTML by grouping contiguous segments (diff vs same)
  let html = ''
  let i = 0
  while (i < cand.length) {
    const same = inLCS.has(i)
    let j = i
    while (j < cand.length && inLCS.has(j) === same) j++
    const segment = cand.slice(i, j)
    html += same ? escapeHtml(segment) : `<span class="diff">${escapeHtml(segment)}</span>`
    i = j
  }
  return html
}

function escapeHtml(str) {
  return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll('\'', '&#39;')
}

/* --- pick best of (title_jpn, title) by similarity to filename --- */
function pickBestTitle(filename, tJpn, tNorm) {
  const fnLow = String(filename || '').toLowerCase()
  const jLow = String(tJpn || '').toLowerCase()
  const tLow = String(tNorm || '').toLowerCase()
  const sJ = jLow ? similarityByLCS(fnLow, jLow) : -1
  const sT = tLow ? similarityByLCS(fnLow, tLow) : -1
  return (sJ >= sT) ? (tJpn || '') : (tNorm || '')
}

/* --- helpers for similarity   end  --- */

// Filter: selected-only or all
const selectedIds = reactive(new Set())
const filteredRows = computed(() => {
  if (filterMode.value === 'selected') {
    return baseRows.value.filter(r => selectedIds.has(r.id))
  } else if (filterMode.value === 'unselected') {
    return baseRows.value.filter(r => !selectedIds.has(r.id))
  }
  return baseRows.value
})

// pagination
const page = ref(1)
const pageSize = computed(() => props.pageSize)
const pageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / pageSize.value)))
watch(filterMode, () => { page.value = 1 })
const pagedRows = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredRows.value.slice(start, start + pageSize.value)
})

// selection controls
const isAllVisibleSelected = computed(() => {
  const vis = pagedRows.value
  if (vis.length === 0) return false
  return vis.every(r => selectedIds.has(r.id))
})
const isIndeterminate = computed(() => {
  const vis = pagedRows.value
  if (vis.length === 0) return false
  const any = vis.some(r => selectedIds.has(r.id))
  return any && !isAllVisibleSelected.value
})

function toggleSelectAllVisible(val) {
  const vis = pagedRows.value
  if (val) vis.forEach(r => selectedIds.add(r.id))
  else vis.forEach(r => selectedIds.delete(r.id))
}

function toggleRow(row, val) {
  if (val) selectedIds.add(row.id)
  else selectedIds.delete(row.id)
}

// focus / preview
const focusedId = ref(null)
const focusedRow = computed(() => {
  if (focusedId.value == null && filteredRows.value.length) {
    return filteredRows.value[0]
  }
  return filteredRows.value.find(r => r.id === focusedId.value) || null
})
watch(focusedId, (id) => {
  if (id == null) return
  ensureTableHighlightsById(id)
})

function onRowClick(row) { focusedId.value = row.id }

// row actions -- highlight the current row
function ensureTableHighlightsById(id) {
  // Try to find the row object currently rendered (pagedRows) to set current-row highlight
  const rowObj = pagedRows.value.find(r => r.id === id)
  if (rowObj) tableRef.value?.setCurrentRow(rowObj)
}

// row actions -- scroll to the focused row

function getBodyScroller() {
  // Element Plus table body can be either of these depending on version
  return tableRef.value?.$el.querySelector('.el-table__body-wrapper, .el-scrollbar__wrap') || null
}

function scrollRowIntoViewById(id, { align = 'nearest' } = {}) {
  const scroller = getBodyScroller()
  if (!scroller) return

  // Find index in the currently rendered data (pagedRows)
  const idx = pagedRows.value.findIndex(r => r.id === id)
  if (idx < 0) return

  const rows = tableRef.value?.$el.querySelectorAll('.el-table__body tbody > tr.el-table__row')
  const tr = rows?.[idx]
  if (tr && typeof tr.scrollIntoView === 'function') {
    tr.scrollIntoView({ block: align, inline: 'nearest', behavior: 'smooth' })
  }
}

function scrollToTop() {
  const scroller = getBodyScroller()
  if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' })
}

function focusNext(afterId, { target = 'unselected' } = {}) {
  const rows = filteredRows.value
  if (!rows.length) {
    focusedId.value = null
    return
  }

  const predicate = target === 'selected'
      ? (r) => selectedIds.has(r.id)
      : (r) => !selectedIds.has(r.id)

  // If no row matches the target condition, don't jump
  if (!rows.some(predicate)) return

  const start = rows.findIndex(r => r.id === afterId)
  let i = ((start >= 0 ? start : -1) + 1) % rows.length
  let wrapped = (i === 0 && start >= 0)

  while (i !== start) {
    if (predicate(rows[i])) {
      const id = rows[i].id
      focusedId.value = id
      ensureTableHighlightsById(id)
      if (wrapped) scrollToTop()
      else scrollRowIntoViewById(id, { align: 'nearest' })
      return
    }
    i = (i + 1) % rows.length
    if (i === 0) wrapped = true
  }

  // Optionally consider the start row if it matches (no movement = still ensure visibility)
  if (start >= 0 && predicate(rows[start])) {
    const id = rows[start].id
    focusedId.value = id
    ensureTableHighlightsById(id)
    scrollRowIntoViewById(id, { align: 'nearest' })
  }
}

function acceptOne(row) {
  selectedIds.add(row.id) // convenience: mark selected after accept-one
  recordAccepted([row.id])
  nextTick(() => focusNext(row.id, { target: 'unselected' }))
}

function rejectOne(row) {
  selectedIds.delete(row.id)
  nextTick(() => focusNext(row.id, { target: 'selected' }))

}

const canRevealInFolder = computed(() => {
  const fr = focusedRow.value
  return !!(fr && (fr.filepath || fr.__raw?.filepath))
})

async function revealInFolder(row) {
  const filepath = row?.filepath || row?.__raw?.filepath
  if (!filepath) {
    ElMessage.warning(t('m.filePathMissing'))
    return
  }
  try {
    await ipcRenderer.invoke('show-file', filepath)
  } catch (e) {
    ElMessage.error(t('m.failedToReveal'))
  }
}

// bulk actions
const bulkBusy = ref(false)

function resetSelected() { selectedIds.clear() }


async function acceptSelected() {
  const ids = Array.from(selectedIds)
  if (ids.length === 0) return
  try {
    await ElMessageBox.confirm(
        t('m.acceptConfirm', { n: ids.length }),
        t('m.confirm'),
        { type: 'warning' }
    )
  } catch { return }

  bulkBusy.value = true
  try {
    for (const id of ids) {
      const book = bookById.value.get(id) // || (bookList.value || []).find(b => b.id === id)
      if (!book) continue
      book.status = 'tagged'
      await saveBook(book)
    }
    recordAccepted(ids)
    selectedIds.clear()
    ElMessage.success(t('m.acceptDone'))

    nextTick(() => {
      const remaining = filteredRows.value[0]
      focusedId.value = remaining?.id ?? null
      if (focusedId.value != null) {
        ensureTableHighlightsById(focusedId.value)
        scrollRowIntoViewById(focusedId.value, { align: 'nearest' })
      } else {
        scrollToTop()
      }
    })

  } finally {
    bulkBusy.value = false
  }
}

//reset metadata
async function onClearMetadataSelected() {
  const ids = Array.from(selectedIds)
  if (!ids.length) return

  // Confirm
  try {
    await ElMessageBox.confirm(
        t('m.clearMetaConfirm', { n: ids.length }),
        t('m.confirm'),
        {
          confirmButtonText: t('m.clearMetadata'),
          cancelButtonText: t('m.cancel'),
          type: 'warning',
          dangerouslyUseHTMLString: false,
        }
    )
  } catch { return }

  bulkBusy.value = true
  try {
    // Loop through selected ids and reset metadata via Pinia
    for (const id of ids) {
      const book = bookById.value.get(id) //|| (bookList.value || []).find(b => (b.id ?? b.idx) === id)
      if (!book) continue
      await resetMetadata(book)
      selectedIds.delete(id)
    }
    ElMessage.success(t('m.clearMetaDone'))


  } finally {
    bulkBusy.value = false
  }
}

// undo accepted

const lastAccepted = ref({ ids: [] })
const canUndoAccept = computed(() => {
  const { ids } = lastAccepted.value || {}
  return Array.isArray(ids) && ids.length > 0
})


// Record last accept (overwrite previous batch)
function recordAccepted(idsArr) {
  lastAccepted.value = { ids: Array.from(new Set(idsArr)) }
}


// Undo handler: flip status back to 'need-verify'
async function undoLastAccept() {
  if (!canUndoAccept.value) return
  const { ids } = lastAccepted.value
  let reverted = 0
  console.log('undoLastAccept', bookById)
  // For a minimal local revert, directly set on book objects:
  for (const id of ids) {
    const book = bookById.value.get(id)  //|| (bookList.value || []).find(b => b.id === id)
    if (!book) continue
    if (book.status !== 'need-verify') {
      book.status = 'need-verify'
      await saveBook(book)
      reverted++
    }
  }

  // Clear the batch so it can’t be undone twice
  lastAccepted.value = { ids: [] }

  // Refresh focus to the first now-visible row
  nextTick(() => {
    const first = filteredRows.value[0]
    focusedId.value = first?.id ?? null
    if (focusedId.value != null) {
      ensureTableHighlightsById(focusedId.value)
      scrollRowIntoViewById(focusedId.value, { align: 'nearest' })
    } else {
      scrollToTop()
    }
  })

  ElMessage.success(t('m.undoAcceptDone', { n: reverted }))
}

// set a sensible focus when opening
watch(visibleProxy, v => {
  if (v) nextTick(() => { focusedId.value = filteredRows.value[0]?.id ?? null })
})

</script>

<style scoped>
.vfm-dialog :deep(.el-dialog__body) {
  padding-top: 8px;
  padding-bottom: 8px;
  overflow: visible; /* allow sticky, popovers */
}

.vfm-header-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.spacer {
  flex: 1;
}

.vfm-main {
  display: grid;
  grid-template-columns: 1fr .38fr; /*  image display ratio  */
  gap: 12px;
  min-height: 56vh;
  align-items: start; /* prevent right pane from stretching */
}

.vfm-left {
  min-width: 0;
  overflow: hidden; /* table has its own internal scroller via height prop */
}

.vfm-right {
  min-width: 330px;
  flex: 0 0 auto;
  position: static;
  z-index: auto;
}

.vfm-right .vfm-card {
  position: sticky;
  top: 8px; /* distance from the dialog header/tools */
}

/* Stack layout on narrow screens */
@media (max-width: 900px) {
  .vfm-main {
    grid-template-columns: 1fr;
  }

  .vfm-right .vfm-card {
    position: static;
  }
}


/* 6) Table rows can grow if titles wrap; table itself keeps a fixed height scroller */
.vfm-table :deep(.el-table__row) {
  height: auto;
  min-height: 56px;
}

.vfm-table :deep(.current-row) {
  background-color: var(--el-color-primary-light-9) !important;
}

/* Allow wrapping only in the stacked-title column cells */
.vfm-table :deep(.col-stacked .cell) {
  white-space: normal; /* override Element Plus default nowrap */
  overflow: visible;
  display: block; /* <-- critical: cancel EP's flex row */
}

/* Ensure the stacked container uses the full cell width */
.vfm-table :deep(.col-stacked .cell .stacked-cell) {
  width: 100%;
}

.vfm-table :deep(.col-stacked .cell .file-line .filename-wrap) {
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
  /* remove ellipsis behavior */
  overflow: visible;
  text-overflow: clip;
}

/* Let the title wrap into multiple lines */
.title-line {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word; /* break long tokens like [group]_[ver]_... */
  line-height: 1.25;
}

/* Keep filename as a single-line ellipsis */
.file-line .ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-line .mono {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Allow row height to grow to fit wrapped titles */
.vfm-table :deep(.el-table__row) {
  height: auto;
  min-height: 56px; /* keep a pleasant minimum */
}

/* Make the two stacked lines highly legible in both themes */
.stacked-cell.two-lines .file-line {
  /* rely on currentColor so it adapts to theme automatically */
  opacity: 1; /* subtle de-emphasis but still readable on dark/light */
  line-height: 1.2;
}

.stacked-cell.two-lines .title-line {
  font-weight: 600; /* boost legibility */
  letter-spacing: 0.2px; /* tiny tracking for scanability */
  line-height: 1.25;
}

/* Diff highlight: high contrast on both dark/light, no theme checks */
.stacked-cell.two-lines .title-line .diff {
  background-color: rgba(255, 196, 0, 0.28); /* amber wash works on white + dark */
  outline: 1px solid rgba(255, 196, 0, 0.60); /* crisp edge for dark UIs */
  border-radius: 4px;
  padding: 0 2px;
  /* subtle underline to guide the eye without overpowering */
  box-shadow: inset 0 -1px 0 rgba(255, 196, 0, 0.9);
  font-weight: 600; /* pop the highlighted bits */
}

/* Ensure long titles remain tidy */
.stacked-cell .ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.title-line :deep(.diff) {
  background-color: rgba(255, 196, 0, 0.28);
  outline: 1px solid rgba(255, 196, 0, 0.6);
  border-radius: 4px;
  padding: 0 2px;
  box-shadow: inset 0 -1px 0 rgba(255, 196, 0, 0.9);
  font-weight: 600;
}

.stacked-cell.two-lines .file-line {
  opacity: 0.86;
  line-height: 1.2;
}

.stacked-cell.two-lines .title-line {
  font-weight: 600;
  letter-spacing: 0.2px;
  line-height: 1.25;
}


.file-line {
  color: var(--el-text-color-secondary);
}

.jpn-line {
  font-weight: 600;
}


.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vfm-card {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.cover-box {
  height: 320px;
  display: grid;
  place-items: center;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
  overflow: hidden;
}

.cover-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.cover-img :deep(.el-image__inner) {
  width: 100%;
  height: 100%;
  object-fit: contain; /* show the whole image */
}

.cover-empty {
  opacity: 0.7;
}

.meta {
  margin-top: 10px;
  display: grid;
  gap: 6px;
}

.meta-row {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 8px;
  align-items: baseline;
}

.meta-row label {
  color: var(--el-text-color-secondary);
}

.row-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}

.vfm-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.vfm-footer .left {
  color: var(--el-text-color-secondary);
  display: flex;
  gap: 8px;
  align-items: center;
}

.vfm-footer .left .sep {
  opacity: 0.6;
}

.vfm-footer .right {
  display: flex;
  gap: 8px;
}

.vfm-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
</style>
