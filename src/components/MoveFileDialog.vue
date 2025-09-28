<template>
  <el-dialog
      v-model="visible"
      :title="$t('m.moveFile') || 'Move file'"
      width="400px"
      @opened="onOpened"
      destroy-on-close
  >
    <el-form label-position="top">
      <div><strong>{{ sourceName }}</strong></div>

      <el-form-item :label="$t('m.sourceFolder') || 'Source folder'" style="margin-top:15px;">

        <el-card body-style="padding:5px 8px;">
          <el-text class="path-text" type="info">
            {{ sourceDir }}
          </el-text>
        </el-card>
      </el-form-item>

      <el-form-item :label="$t('m.destinationFolder') || 'Destination folder'">
        <div v-if="!targetDir" style="display:flex;gap:8px;">
          <el-button type="primary" @click="pickFolder">
            {{ $t('m.browse') || 'Choose folder…' }}
          </el-button>
        </div>

        <!-- When a folder is selected -->
        <div v-else class="dest-row">
          <el-card body-style="padding:5px 8px;">
            <el-text class="path-text" type="info">
              {{ destDir }}
            </el-text>
          </el-card>
          <el-button type="primary" size="small" @click="pickFolder"
                     style="display:flex;gap:8px; margin-top:10px">
            {{ $t('m.browse') || 'Change…' }}
          </el-button>
        </div>
      </el-form-item>

      <el-alert
          v-if="samePath"
          :title="$t('m.samePathWarn') || 'Destination equals source. Pick another folder.'"
          type="warning"
          :closable="false"
          show-icon
      />
    </el-form>

    <template #footer>
      <el-button @click="close">{{ $t('c.cancel') || 'Cancel' }}</el-button>
      <el-button type="primary" :disabled="!canConfirm" @click="confirm">
        {{ $t('m.move') || 'Move' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script>


export default {
  name: 'MoveFileDialog',
  emits: ['file-moved'],
  props: {
    saveBookFn: { type: Function, required: true },
  },
  data() {
    return {
      visible: false,
      book: null,      // { filepath, ... }
      targetDir: '',
    }
  },
  computed: {
    destDir() {
      return this.targetDir || ''
    },
    sourceName() {
      const fp = this.book?.filepath || ''
      return fp.split(/[\\/]/).pop() || ''
    },
    sourceDir() {
      const fp = this.book?.filepath || ''
      return fp.replace(/[\\/][^\\/]*$/, '') // drop the last segment
    },
    samePath() {
      if (!this.book?.filepath || !this.targetDir) return false
      // Compare normalized strings: dir + sep + filename vs original
      const sep = this.targetDir.includes('\\') ? '\\' : '/'
      const candidate = this.targetDir.endsWith(sep)
          ? this.targetDir + this.sourceName
          : this.targetDir + sep + this.sourceName
      return candidate === this.book.filepath
    },
    canConfirm() {
      return !!this.book?.filepath && !!this.targetDir && !this.samePath
    },
  },
  methods: {
    openMoveDialog(book) {
      this.book = book || null
      this.visible = true
      this.targetDir = ''
    },
    close() {
      this.visible = false
      this.book = null
      this.targetDir = ''
    },
    onOpened() {
      this.pickFolder() // auto-open native picker; remove if you prefer manual
    },
    async pickFolder() {
      try {
        const path = await ipcRenderer.invoke('select-folder')
        if (path) this.targetDir = path
      } catch (e) {
        console.error(e)
      }
    },

    async confirm() {
      try {
        const newFilePath = await ipcRenderer.invoke(
            'move-local-book',
            this.book.filepath, // oldPath
            this.targetDir,      // targetDir
        )
        if (newFilePath) {
          this.book.filepath = newFilePath
          await this.saveBookFn(this.book)
          this.close()
        }
      } catch (e) {
        console.error(e)
      }
    },
  },
}
</script>

<style>
.path-text {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: normal;
  overflow-wrap: anywhere; /* modern wrap */
  word-break: break-word; /* fallback */
  line-height: 1.3;
}
</style>
