<template>
  <el-dialog v-model="dialogVisibleSetting"
             width="54em"
             :modal="false"
             append-to-body
             top="60px"
             class="setting-dialog"
             @open='onSettingOpen'
  >
    <template #header><p class="setting-title">{{$t('m.setting')}}</p></template>
    <el-tabs v-model="activeSettingPanel" class="setting-tabs">
      <el-tab-pane :label="$t('m.general')" name="general">
        <el-row :gutter="8">
          <!--   display library & add/remove buttons jump to the library tab       -->
          <el-col :span="24">
            <div class="setting-line">
              <el-input class="lib-input" readonly :input-style="{ width: '0', padding: 0, border: 'none' }">
                <!-- left label -->
                <template #prepend>
                  <span class="setting-label">{{$t('m.library')}}</span>
                </template>

                <!-- inline preview of first 1-2 folders + "+N more" -->
                <template #suffix>
                  <div class="lib-preview">
                    <el-space wrap>
                      <el-tag v-for="p in libHead" :key="p" type="info">
                        <el-tooltip :content="p" placement="left-start">
                          <span class="chunk-path"> {{p}} </span></el-tooltip>
                      </el-tag>

                      <!-- +N more popover -->
                      <el-popover
                          v-if="libMoreCount > 0"
                          placement="bottom"
                          trigger="click"
                          width="520"
                      >
                        <template #reference>
                          <el-tag type="success" size="small">+{{libMoreCount}} {{$t('m.more') || 'more'}}</el-tag>
                        </template>

                        <!-- full list inside popover -->
                        <div class="lib-popover">
                          <el-scrollbar max-height="200" wrap-style="padding-bottom:10px">
                            <div class="lib-list">
                              <el-tag v-for="p in libs" :key="p" size="small" type="info" effect="plain">
                                <el-tooltip :content="p" placement="top">
                                  <span class="truncate">{{p}}</span>
                                </el-tooltip>
                              </el-tag>
                            </div>
                          </el-scrollbar>
                          <div class="lib-popover-actions">
                            <el-button size="small" @click="openLibrariesTab">{{
                                $t('m.manage') || 'Manage'
                              }}
                            </el-button>
                          </div>
                        </div>
                      </el-popover>

                      <!-- empty state -->
                      <span v-if="libs.length === 0" class="dim">{{
                          $t('m.noLibraryFolders') || 'No library folders added yet'
                        }}</span>
                    </el-space>
                  </div>
                </template>

                <!-- right button -->
                <template #append>
                  <el-button size="small" @click="openLibrariesTab">{{$t('m.manage') || 'Manage'}}</el-button>
                </template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.metadataPath" :placeholder="$t('m.metadataPathDefault')">
                <template #prepend><span class="setting-label">{{$t('m.metadataPath')}}</span></template>
                <template #append>
                  <el-button @click="selectMetadataPath">{{$t('m.select')}}</el-button>
                </template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.imageExplorer" @change="saveSetting">
                <template #prepend><span class="setting-label">{{$t('m.imageViewer')}}</span></template>
                <template #append>
                  <el-button @click="selectImageExplorerPath">{{$t('m.select')}}</el-button>
                </template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input class="label-input">
                <template #prepend><span class="setting-label">{{$t('m.theme')}}</span></template>
                <template #append>
                  <el-select placeholder=" " v-model="setting.theme" @change="handleThemeChange">
                    <el-option label="Default Dark" value="dark"></el-option>
                    <el-option label="Default Light" value="light"></el-option>
                    <el-option label="ExHentai" value="dark exhentai"></el-option>
                    <el-option label="E-Hentai" value="light e-hentai"></el-option>
                    <el-option label="nHentai" value="dark nhentai"></el-option>
                  </el-select>
                </template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.igneous" @change="saveSetting">
                <template #prepend><span class="setting-label">igneous</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.ipb_pass_hash" @change="saveSetting">
                <template #prepend><span class="setting-label">ipb_pass_hash</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.ipb_member_id" @change="saveSetting">
                <template #prepend><span class="setting-label">ipb_member_id</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.star" @change="saveSetting">
                <template #prepend><span class="setting-label">star</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.proxy" @change="saveSetting"
                        :placeholder="$t('m.like') + ' http://127.0.0.1:7890'">
                <template #prepend><span class="setting-label">{{$t('m.proxy')}}</span></template>
                <template #append>
                  <el-button @click="testProxy">{{$t('m.test')}}</el-button>
                </template>
              </el-input>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>
      <el-tab-pane :label="$t('m.manageLibrary')" name="libraries">
        <el-row :gutter="8">
          <!-- Row: quick actions -->
          <el-col :span="24">
            <div class="setting-line">
              <el-form-item :label="$t('m.library')" class="lib-line" style="margin-right:auto">
                <el-button type="primary" style="margin-left:auto" size="small" plain @click="addLibraries">
                  {{$t('m.addFolder') || 'Add folders…'}}
                </el-button>
              </el-form-item>
            </div>
          </el-col>

          <!-- Row: list (sortable, removable) -->
          <el-table
              ref='libTableRef'
              :data="workingLibraries"
              max-height="260"
              border
              fit
              stripe
              highlight-current-row
              @current-change="onRowSelect"
          >
            <el-table-column type="index" label="#" width="40" class-name="col-index"/>

            <el-table-column :label="$t('m.path') || 'Path'" class-name="col-path">
              <template #default="{ row }">
                <el-tooltip :content="row.path" placement="top">
                  <span class="libpath">{{row.path}}</span>
                </el-tooltip>
              </template>
            </el-table-column>

            <el-table-column
                :label="$t('m.status') || 'Status'"
                width="90"
                fixed="right"
                class-name="col-right"
            >
              <template #default="{ row }">
                <el-tag v-if="row.exists" type="success" size="small" effect="light">
                  {{$t('m.exists') || 'Exists'}}
                </el-tag>
                <el-tag v-else type="warning" size="small" effect="light">
                  {{$t('m.missing') || 'Missing'}}
                </el-tag>
              </template>
            </el-table-column>

            <!-- Actions (flush right, far right) -->
            <el-table-column
                :label="$t('m.actions') || 'Actions'"
                width="90"
                fixed="right"
                class-name="col-right"
            >
              <template #default="{ $index }">
                <el-button size="small" type="danger" plain @click="removeAt($index)">
                  {{$t('m.remove') || 'Remove'}}
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <!-- Row: footer buttons -->
          <el-col :span="24">
            <div class="setting-line" style="display:flex; justify-content:flex-end; gap:8px; padding-top:10px">
              <el-button size="small" @click="openInOS" :disabled="!currentPath">
                {{$t('m.reveal') || 'Reveal in OS'}}
              </el-button>
              <el-button size="small" type="success" @click="saveLibraries">{{$t('m.save') || 'Save'}}</el-button>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>
      <el-tab-pane :label="$t('m.batchMetaUpdate')" name="update">
        <!-- ===== Header: counts ===== -->
        <el-row :gutter="8" class="mb8">
          <el-col :span="24">
            <div class="setting-hd">
              <h3 class="setting-title">{{$t('m.batchMetadataUpdate')}}</h3>
            </div>
          </el-col>
        </el-row>

        <!-- ===== Methods: Public API ===== -->
        <el-card shadow="never" class="mb8">
          <template #header>
            <div class="card-hd">
              <span>{{$t('m.methodPublicAPI')}}</span>
              <div class="spacer"></div>
              <el-tag :type="apiStatus.type" effect="plain" class="mr8">{{apiStatus.text}}</el-tag>
              <el-button size="small" @click="testPublicAPI"
                         :disabled="!setting.batchUpdateApiEnabled">{{$t('m.test')}}
              </el-button>
              <el-switch v-model="setting.batchUpdateApiEnabled" class="ml8"
                         :active-text="$t('m.enable')" @change="saveSetting"/>
            </div>
          </template>

          <!-- mid row: configuration -->
          <el-row :gutter="8" class="update-method">
            <el-col :span="12" class="mb8">
              <el-input v-model="setting.igneous" class="fixed-prepend" @change="saveSetting">
                <template #prepend>igneous</template>
              </el-input>
            </el-col>
            <el-col :span="12" class="mb8">
              <el-input v-model="setting.ipb_member_id" class="fixed-prepend" @change="saveSetting">
                <template #prepend>ipb_member_id</template>
              </el-input>
            </el-col>

            <el-col :span="12" class="mb8">
              <el-input v-model="setting.ipb_pass_hash" class="fixed-prepend" @change="saveSetting">
                <template #prepend>ipb_pass_hash</template>
              </el-input>
            </el-col>
            <el-col :span="12" class="mb8">
              <el-input v-model="setting.star" class="fixed-prepend" @change="saveSetting">
                <template #prepend>star</template>
              </el-input>
            </el-col>

          </el-row>

          <!-- footer: info -->
          <div class="method-footer">
            <span class="hint"> {{$t('update.apiSetting')}} </span>
          </div>
        </el-card>

        <!-- ===== Methods: Offline (SQLite) ===== -->
        <el-card shadow="never" class="mb8">
          <template #header>
            <div class="card-hd">
              <span>{{$t('m.methodOfflineSQLite')}}</span>
              <div class="spacer"></div>

              <!-- Add file (left of Check) -->
              <el-button
                  type="primary"
                  size="small"
                  class="mr8"
                  :disabled="offlineBusy"
                  @click="AddApiDumpDB"
              >
                {{$t('m.sqliteFile')}}
              </el-button>

              <!-- Initialize ALL (~1 min each) -->
              <el-button
                  v-if="offlineDbRows && offlineDbRows.filter(r => r && r.exists === true && r.isValid !== false && r.isInit === false).length >= 2"
                  size="small"
                  class="mr4"
                  :disabled="offlineBusy
          || !setting.batchUpdateDBEnabled
          || offlineDbRows.filter(r => r && r.exists === true && r.isValid !== false && r.isInit === false).length === 0"
                  @click="initOfflineDb"
              >
                {{$t('m.initializeAllDb')}} (~1 min)
              </el-button>

              <!-- Check all -->
              <el-button
                  size="small"
                  class="mr8"
                  :disabled="offlineBusy || !setting.batchUpdateDBEnabled"
                  @click="testOfflineDb"
              >
                {{$t('m.check')}}
              </el-button>

              <!-- Enable switch -->
              <el-switch
                  v-model="setting.batchUpdateDBEnabled"
                  class="ml8"
                  :active-text="$t('m.enable')"
                  :disabled="offlineBusy"
                  @change="saveSetting"
              />
            </div>
          </template>

          <!-- mid: table -->
          <div class="update-method">
            <el-table
                :data="offlineDbRows"
                border
                size="small"
                style="width: 100%"
                max-height="135px"
                :row-key="r => r.path"
                :header-cell-style="{ whiteSpace: 'nowrap' }"
            >
              <!-- 1) index -->
              <el-table-column type="index" label="#" width="60"/>

              <!-- 2) DB path -->
              <el-table-column :label="$t('m.sqliteFile')" min-width="350" show-overflow-tooltip>
                <template #default="{ row }">
                  <el-tooltip :content="row.path" placement="top">
                    <span class="mono ellipsis">{{row.path}}</span>
                  </el-tooltip>
                </template>
              </el-table-column>

              <!-- Status (Exists? Valid/Init) -->
              <el-table-column :label="$t('m.statusCol')" width="130" align="center" fixed="right">
                <template #default="{ row }">
                  <el-space :size="5" alignment="center">
                    <!-- Pill A: Exists? -->
                    <el-tag v-if="row.exists === null" type="info" effect="plain">?</el-tag>
                    <el-tag v-else-if="row.exists === true" type="success" effect="plain">✓</el-tag>
                    <el-tag v-else type="danger" effect="plain">✗</el-tag>

                    <!-- Pill B: Valid/Init -->
                    <el-tag v-if="row.isValid === false" type="danger" effect="plain">{{$t('m.notValidDb')}}</el-tag>
                    <el-tag v-else-if="row.isInit === null" type="info" effect="plain">{{$t('m.unknown')}}</el-tag>
                    <el-tag v-else-if="row.isInit === true" type="success" effect="plain">{{$t('m.ready')}}</el-tag>
                    <el-tag v-else-if="row.isInit === 'failed'" type="danger" effect="plain">{{$t('m.initFailed')}}
                    </el-tag>
                    <el-tag v-else type="warning" effect="plain">{{$t('m.notInit')}}</el-tag>
                  </el-space>
                </template>
              </el-table-column>
              <!-- 5) Init (per-row) -->
              <el-table-column :label="$t('m.init')" width="75" align="center" fixed="right">
                <template #default="{ row }">
                  <el-button
                      size="small"
                      type="primary"
                      text
                      :loading="row.running"
                      :disabled="offlineBusy
              || !setting.batchUpdateDBEnabled
              || row.exists !== true
              || row.isValid === false
              || row.isInit === true"
                      @click="initOfflineDb(row)"
                  >
                    {{$t('m.init')}}
                  </el-button>
                </template>
              </el-table-column>

              <!-- 6) Remove -->
              <el-table-column :label="$t('m.actions')" width="85" align="center" fixed="right">
                <template #default="{ row }">
                  <el-button
                      size="small"
                      type="danger"
                      text
                      :disabled="offlineBusy"
                      @click="removeDb(row.path)"
                  >
                    {{$t('m.remove')}}
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <!-- footer -->
          <div class="method-footer">
            <template v-if="offlineBusy">
              <span class="hint">{{$t('m.working')}}…</span>
            </template>
            <template v-else>
              <span class="hint">{{$t('m.offlineDBInitMessage')}}</span>
            </template>
          </div>
        </el-card>

        <!-- ===== Methods: Local Folder ===== -->
        <el-card shadow="never" class="mb16">
          <template #header>
            <div class="card-hd">
              <span>{{$t('m.methodLocalFolder')}}</span>
              <div class="spacer"></div>
              <el-tag type="info" effect="plain" class="mr8">{{$t('m.ready')}}</el-tag>
              <el-switch v-model="setting.batchUpdateEHViewerEnabled" :active-text="$t('m.enable')"
                         @change="saveSetting"/>
            </div>
          </template>

          <!-- mid row: configuration (none) -->
          <el-alert
              :title="$t('m.localFolderInfoTitle')"
              type="info"
              :closable="false"
              show-icon
              class="compact-alert"
              description=".ehviewer data / info.json / tags.txt · {{$t('m.expectOneBookPerFolder')}}"
          />

          <!-- footer: info -->
          <div class="method-footer">
            <span class="hint">{{$t('m.localFolderHint')}}</span>
          </div>
        </el-card>

        <!-- ===== Actions: scope + Start ===== -->
        <el-row :gutter="8" align="middle" class="actions-row">
          <el-col :span="16">
            <div class="scope-row">
              <span class="scope-label">{{$t('m.scope')}}</span>
              <el-radio-group v-model="scope" size="small">
                <el-radio-button label="no-tag">{{$t('m.scopeNoTagOnly')}}</el-radio-button>
                <el-radio-button label="all">{{$t('m.scopeAllPending')}}</el-radio-button>
              </el-radio-group>
              <span class="scope-hint"
                    v-if="scope==='all'">({{$t('m.includes')}}: {{$t('m.noTag')}}, {{$t('m.tagFailed')}}, {{$t('m.needVerify')}})</span>
            </div>
          </el-col>
          <el-col :span="8" class="tr">
            <el-button
                type="primary"
                :disabled="!canStart() || startBusy"
                @click="onStart"
            >
              {{$t('m.startUpdate')}}
            </el-button>
          </el-col>
        </el-row>
      </el-tab-pane>
      <el-tab-pane :label="$t('m.internalViewer')" name="internalViewer">
        <el-row :gutter="8">
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model.number="setting.thumbnailColumn" @change="saveSetting">
                <template #prepend><span class="setting-label">{{$t('m.thumbnailColumn')}}</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model.number="setting.widthLimit" :placeholder="$t('m.widthLimitInfo')" @change="saveSetting">
                <template #prepend><span class="setting-label">{{$t('m.widthLimit')}}</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24" class="setting-switch">
            <el-switch
                v-model="setting.hidePageNumber"
                :active-text="$t('m.hidePageNumber')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="24" class="setting-switch">
            <el-switch
                v-model="setting.keepReadingProgress"
                :active-text="$t('m.keepReadingProgress')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="24" class="setting-switch">
            <el-switch
                v-model="setting.reverseLeftRight"
                :active-text="$t('m.reverseLeftRight')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="24" class="setting-switch">
            <el-switch
                v-model="setting.autoNextManga"
                :active-text="$t('m.autoNextManga')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="24" class="setting-switch">
            <el-switch
                v-model="setting.defaultInsertEmptyPage"
                :active-text="$t('m.defaultInsertEmptyPage')"
                @change="saveSetting"
            />
          </el-col>
        </el-row>
      </el-tab-pane>
      <el-tab-pane :label="$t('m.collectTag')" name="collectTag">
        <el-row :gutter="8">
          <el-col :span="24" class="setting-line collect-tag">
            <draggable
                v-model="setting.collectTag"
                item-key="id"
                animation="200"
                @change="saveSetting"
            >
              <template #item="{element}">
                <el-tag :color="element.color" effect="dark" closable @close="removeTag(element.id)">
                  {{element.letter}}:{{resolvedTranslation[element.tag]?.name || element.tag}}
                </el-tag>
              </template>
            </draggable>
          </el-col>
          <el-col :span="24" class="setting-line collect-tag">
            <el-form :inline="true" :model="formTagAdd" :show-message="false">
              <el-form-item :label="$t('m.tag')">
                <el-select-v2
                    v-model="formTagAdd.tag"
                    filterable clearable :height="340"
                    style="width: 500px"
                    :options="tagListForCollect"
                ></el-select-v2>
              </el-form-item>
              <el-form-item :label="$t('m.tagColor')">
                <el-color-picker v-model="formTagAdd.color" show-alpha :predefine="moderateSoftColors"/>
              </el-form-item>
              <el-form-item>
                <el-button plain @click="addTagToCollect">{{$t('m.addTag')}}</el-button>
              </el-form-item>
            </el-form>
          </el-col>
          <el-col :span="24" class="setting-switch">
            <el-switch
                v-model="setting.showCollectTag"
                :active-text="$t('m.showCollectTag')"
                @change="saveSetting"
            />
          </el-col>
        </el-row>
      </el-tab-pane>
      <el-tab-pane :label="$t('m.advanced')" name="advanced">
        <el-row :gutter="8">
          <el-col :span="24">
            <div class="setting-line">
              <el-input class="label-input">
                <template #prepend><span class="setting-label">{{$t('m.language')}}</span></template>
                <template #append>
                  <el-select placeholder=" " v-model="setting.language" @change="handleLanguageChange">
                    <el-option :label="$t('m.systemDefault')" value="default"></el-option>
                    <el-option label="zh-CN" value="zh-CN"></el-option>
                    <el-option label="zh-TW" value="zh-TW"></el-option>
                    <el-option label="en-US" value="en-US"></el-option>
                  </el-select>
                </template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input class="label-input">
                <template #prepend><span class="setting-label">{{$t('m.directEnter')}}</span></template>
                <template #append>
                  <el-select placeholder=" " v-model="setting.directEnter" @change="saveSetting">
                    <el-option :label="$t('m.detailPage')" value="detail"></el-option>
                    <el-option :label="$t('m.internalViewer')" value="internalViewer"></el-option>
                    <el-option :label="$t('m.externalViewer')" value="externalViewer"></el-option>
                  </el-select>
                </template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input class="label-input">
                <template #prepend><span class="setting-label">{{$t('m.displayTitle')}}</span></template>
                <template #append>
                  <el-select :placeholder="$t('m.displayTitleInfo')" v-model="setting.displayTitle"
                             @change="saveSetting">
                    <el-option :label="$t('m.englishTitle')" value="englishTitle"></el-option>
                    <el-option :label="$t('m.japaneseTitle')" value="japaneseTitle"></el-option>
                    <el-option :label="$t('m.filename')" value="filename"></el-option>
                  </el-select>
                </template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input class="label-input">
                <template #prepend><span class="setting-label">{{$t('m.defaultScraper')}}</span></template>
                <template #append>
                  <el-select v-model="setting.defaultScraper" @change="saveSetting">
                    <el-option v-for="searchType in searchTypeList" :key="searchType.value" :label="searchType.label"
                               :value="searchType.value"/>
                  </el-select>
                </template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model.number="setting.requireGap" :placeholder="$t('m.requireGapInfo')" @change="saveSetting">
                <template #prepend><span class="setting-label">{{$t('m.requestGap')}}</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <NameFormItem class="setting-line" prependWidth="110px">
              <template #prepend>{{$t('m.customOptions')}}</template>
              <template #default>
                <el-input
                    v-model="setting.customOptions" :placeholder="$t('m.customOptionsPlaceholder')"
                    @change="saveSetting"
                    type="textarea" :autosize="{ minRows: 2, maxRows: 4 }"
                ></el-input>
              </template>
            </NameFormItem>
          </el-col>
          <el-col :span="24">
            <div class="setting-line regexp">
              <el-input v-model="setting.trimTitleRegExp" :placeholder="$t('m.trimTitleRegExpInfo')"
                        @change="saveSetting">
                <template #prepend><span class="setting-label">{{$t('m.trimTitleRegExp')}}</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.searchKeySuffix" :placeholder="$t('m.searchKeySuffixInfo')"
                        @change="saveSetting">
                <template #prepend><span class="setting-label">{{$t('m.searchKeySuffix')}}</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line regexp">
              <el-input v-model="setting.excludeFile" :placeholder="$t('m.excludeFileInfo')" @change="saveSetting">
                <template #prepend><span class="setting-label">{{$t('m.excludeFile')}}</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="setting-line">
              <el-input v-model="setting.folderTreeWidth" :placeholder="$t('m.folderTreeWidthInfo')"
                        @change="saveSetting">
                <template #prepend><span class="setting-label">{{$t('m.folderTreeWidth')}}</span></template>
              </el-input>
            </div>
          </el-col>
          <el-col :span="24">
            <NameFormItem class="setting-line" prependWidth="110px" appendWidth="0">
              <template #prepend>{{$t('m.customCss')}}</template>
              <template #default>
                <el-input
                    v-model="setting.customCss" :placeholder="$t('m.customCssPlaceholder')" @change="saveSetting"
                    type="textarea" :autosize="{ minRows: 2, maxRows: 4 }"
                ></el-input>
              </template>
              <template #append>
                <el-button text :icon="MdRefresh" @click="reloadWindow"></el-button>
              </template>
            </NameFormItem>
          </el-col>
          <!-- Concurrent Scan / Write (value on top, dropdown below) -->
          <el-col :span="24">
            <el-row :gutter="12">
              <!-- Left: concurrent scan -->
              <el-col :span="12">
                <div class="setting-line setting-line--concurrency">
                  <el-input class="label-input">
                    <template #prepend>
                      <span class="setting-label-wide">{{$t('m.concurrentScan')}} </span>
                    </template>
                    <template #append>
                      <el-select
                          v-model="setting.concurrentScan"
                          @change="saveSetting"
                          placeholder=" "
                          placement="bottom-start"
                          :fit-input-width="true"
                          :teleported="true"
                      >
                        <el-option
                            v-for="n in concurrencyOptionCeiling"
                            :key="'scan-' + n"
                            :label="n"
                            :value="n"
                        />
                      </el-select>
                    </template>
                  </el-input>
                </div>
              </el-col>

              <!-- Right: concurrent write -->
              <el-col :span="12">
                <div class="setting-line setting-line--concurrency">
                  <el-input class="label-input">
                    <template #prepend>
                      <span class="setting-label-wide">{{$t('m.concurrentWrite')}}</span>
                    </template>
                    <template #append>
                      <el-select
                          v-model="setting.concurrentWrite"
                          @change="saveSetting"
                          placeholder=" "
                          placement="bottom-start"
                          :fit-input-width="true"
                          :teleported="true"
                      >
                        <el-option
                            v-for="n in concurrencyOptionCeiling"
                            :key="'write-' + n"
                            :label="n"
                            :value="n"
                        />
                      </el-select>
                    </template>
                  </el-input>
                </div>
              </el-col>
            </el-row>
          </el-col>
          <el-col :span="8">
            <div class="setting-line">
              <el-popconfirm
                  placement="top-start"
                  :title="$t('m.rebuildWarning')"
                  @confirm="forceGeneBookList"
              >
                <template #reference>
                  <el-button class="function-button" plain>{{$t('m.rebuildLibrary')}}</el-button>
                </template>
              </el-popconfirm>
            </div>
          </el-col>
          <el-col :span="8">
            <div class="setting-line">
              <el-popconfirm
                  placement="top-start"
                  :title="$t('m.patchWarning')"
                  @confirm="patchLocalMetadata"
              >
                <template #reference>
                  <el-button class="function-button" type="primary" plain>{{$t('m.patchLocalMetadata')}}</el-button>
                </template>
              </el-popconfirm>
            </div>
          </el-col>
          <el-col :span="8">
            <div class="setting-line">
              <el-button class="function-button" type="primary" plain @click="exportDatabase">{{
                  $t('m.exportMetadata')
                }}
              </el-button>
            </div>
          </el-col>
          <el-col :span="8">
            <div class="setting-line">
              <el-button class="function-button" type="primary" plain @click="importDatabase">{{
                  $t('m.importMetadata')
                }}
              </el-button>
            </div>
          </el-col>
          <el-col :span="8">
            <div class="setting-line">
              <el-button class="function-button" type="primary" plain @click="importMetadataFromSqlite">{{
                  $t('m.importMetadataFromSqlite')
                }}
              </el-button>
            </div>
          </el-col>
          <el-col :span="8">
            <div class="setting-line">
              <el-button class="function-button" type="danger" :icon="Delete"
                         :loading="busyRemove" :disabled="busyRemove" @click="removeMissingRecords"
              >{{$t('m.removeMissingRecords')}}
              </el-button>
            </div>
          </el-col>
        </el-row>
        <el-row :gutter="8">
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.loadOnStart"
                :active-text="$t('m.onStartScan')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.startOnLogin"
                :active-text="$t('m.startOnLogin')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.autoCheckUpdates"
                :active-text="$t('m.autoCheckUpdates')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.enabledLANBrowsing"
                :active-text="$t('m.enabledLANBrowsing')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="12" class="setting-switch">
            <el-switch
                v-model="setting.batchTagfailedBook"
                :active-text="$t('m.batchTagfailedBook')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="12" class="setting-switch">
            <el-switch
                v-model="setting.onlyGetMetadataOfSelectedFolder"
                :active-text="$t('m.onlyGetMetadataOfSelectedFolder')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.showComment"
                :active-text="$t('m.showComment')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.showTranslation"
                :active-text="$t('m.tagTranslate')"
                @change="handleTranslationSettingChange"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.skipDeleteConfirm"
                :active-text="$t('m.skipDeleteConfirm')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.disableRandomTag"
                :active-text="$t('m.disableRandomTag')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.minimizeOnStart"
                :active-text="$t('m.minimizeOnStart')"
                @change="saveSetting"
            />
          </el-col>
          <el-col :span="6" class="setting-switch">
            <el-switch
                v-model="setting.minimizeToTray"
                :active-text="$t('m.minimizeToTray')"
                @change="saveSetting"
            />
          </el-col>
        </el-row>
      </el-tab-pane>
      <el-tab-pane :label="$t('m.accelerator')" name="accelerator">
        <el-descriptions
            :column="2" size="small" style="margin-top: 16px;"
            v-for="group in acceleratorInfo" :key="group.group"
            :title="$t(`ac.${group.group}`)"
        >
          <el-descriptions-item v-for="(value, key) in group.accelerators" :key="value" width="22em">
            <template #label><span style="display: inline-block; min-width: 10em;">{{
                $t(`ac.${group.group}_${key}`)
              }}</span></template>
            <el-tag>{{value}}</el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </el-tab-pane>
      <el-tab-pane :label="$t('m.about')" name="about">
        <el-descriptions :column="1">
          <el-descriptions-item :label="$t('m.appName')+':'">exhentai-manga-manager</el-descriptions-item>
          <el-descriptions-item :label="$t('m.version')+':'">
            <a href="#"
               @click="openLink('https://github.com/SchneeHertz/exhentai-manga-manager/releases')">{{version}}</a>
          </el-descriptions-item>
          <el-descriptions-item :label="$t('m.appPage')+':'">
            <a href="#" @click="openLink('https://github.com/SchneeHertz/exhentai-manga-manager')">github</a>
          </el-descriptions-item>
          <el-descriptions-item :label="$t('m.help')+':'">
            <a v-if="['zh-CN', 'zh-TW'].includes($i18n.locale)" href="#"
               @click="openLink('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/中文说明')">github wiki</a>
            <a v-else href="#"
               @click="openLink('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/English-Instruction')">github
              wiki</a>
          </el-descriptions-item>
          <el-descriptions-item :label="$t('m.donation')+':'">
            <a v-if="['zh-CN', 'zh-TW'].includes($i18n.locale)" href="#"
               @click="openLink('https://afdian.com/a/SeldonHorizon')">爱发电</a>
            <a v-else href="#" @click="openLink('https://www.buymeacoffee.com/schneehertz')">buy me a coffee</a>
          </el-descriptions-item>
        </el-descriptions>
        <img src="/icon.png" class="about-logo">
        <el-row>
          <el-col :span="4" :offset="10">
            <div class="setting-line">
              <el-button class="function-button" type="primary" plain @click="autoCheckUpdates(true)">{{
                  $t('m.checkUpdates')
                }}
              </el-button>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
</template>

<script setup>
import { ref, onMounted, h, computed, reactive, watch, watchEffect, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete } from '@element-plus/icons-vue'
import draggable from 'vuedraggable'
import { MdRefresh } from '@vicons/ionicons4'

import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import zhTw from 'element-plus/dist/locale/zh-tw.mjs'
import en from 'element-plus/dist/locale/en.mjs'

import { version } from '../../package.json'
import { gh_token } from '../../secret_key.json'
import { acceleratorInfo } from '../utils.js'
import NameFormItem from './NameFormItem.vue'

import { storeToRefs } from 'pinia'
import { useAppStore } from '../pinia.js'

const appStore = useAppStore()
const { searchTypeList, setting, bookList, resolvedTranslation, localeFile, tagListRaw, cookie } = storeToRefs(appStore)
const { printMessage } = appStore

const { t, locale } = useI18n()
const dialogVisibleSetting = ref(false)
const activeSettingPanel = ref('general')

const emit = defineEmits([
  'loadBookList',
  'loadCollectionList',
])

// concurrent scan options; default is min(concurrencyOptionCeiling, 4)
const concurrencyOptionCeiling = Math.max(1, Number(navigator.hardwareConcurrency) || 4)
const defaultConcurrentScan = Math.min(concurrencyOptionCeiling, 4)
const defaultConcurrentWrite = Math.min(concurrencyOptionCeiling, 2)

const normalizeConcurrency = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 && n <= concurrencyOptionCeiling ? Math.trunc(n) : fallback
}

onMounted(() => {
  ipcRenderer.invoke('load-setting').then(async (res) => {
    setting.value = res
    // set default value
    if (res.autoCheckUpdates === undefined) setting.value.autoCheckUpdates = true
    if (res.trimTitleRegExp ===
        undefined) setting.value.trimTitleRegExp = '^\\d+[-]?\\s*|\\s*(\\[[^\\]]*\\]|\\([^\\)]*\\)|【[^】]*】|（[^）]*）)\\s*'
    if (res.defaultScraper === undefined) setting.value.defaultScraper = 'exhentai'
    if (res.defaultInsertEmptyPage === undefined) setting.value.defaultInsertEmptyPage = true
    setting.value.concurrentScan = normalizeConcurrency(res.concurrentScan, defaultConcurrentScan)
    setting.value.concurrentWrite = normalizeConcurrency(res.concurrentWrite, defaultConcurrentWrite)
    // libray folders
    const okPath = validateLibrariesShallow(setting.value.libraries)
    if (!okPath) {
      setting.value.libraries = []
    } else {
      setting.value.libraries = [...new Set(setting.value.libraries)]
    }
    // offline api_dump.sqlite
    if (!Array.isArray(setting.value.apiDumpDbPaths)) {
      setting.value.apiDumpDbPaths = []
    } else {
      setting.value.apiDumpDbPaths = [...new Set(setting.value.apiDumpDbPaths)]
    }
    saveSetting()

    // default action
    if (res.theme) changeTheme(res.theme)
    // another saveSetting inside, causing race json writing. The resulting setting.json will be {...}...}
    // we serialize saves in ipcRenderer.invoke('save-setting'
    handleLanguageChange(res.language)
    if (res.showTranslation) loadTranslationFromEhTagTranslation()
    if (res.autoCheckUpdates) autoCheckUpdates(false)
    if (res.enabledLANBrowsing) ipcRenderer.invoke('enable-LAN-browsing')
    if (res.customCss) electronFunction['insert-css'](res.customCss)
  })
})

/*          Library Folder Management
 * -------------------------------------------
 */
// TODO: simplify the folder management tab: no more save, change on save
const workingLibraries = ref([])
const libTableRef = ref(null)
const libs = computed(() => setting.value.libraries || [])
// only show the first two paths in the General tab
const libHead = computed(() => libs.value.slice(0, 2))
const libMoreCount = computed(() => Math.max(0, libs.value.length - libHead.value.length))

// verify the libraries setting is a list of paths
// Heuristic "looks like a path" (works for POSIX, Windows, UNC, ~)
function looksLikePath(s) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (!t) return false

  // Accept home-relative
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) return true

  // Windows drive:  C:\ or C:/ ...
  if (/^[A-Za-z]:[\\/]/.test(t)) return true

  // UNC share: \\Server\Share\...  or //Server/Share/...
  if (/^(\\\\|\/\/)[^\\\/]+[\\\/][^\\\/]+/.test(t)) return true

  // POSIX absolute: /usr/lib ...
  if (/^\//.test(t)) return true

  // Fallback: treat as relative path if it has a separator and no obviously illegal chars
  // (keep this lenient since we aren't checking existence)
  if (
      /[\\/]/.test(t) &&                 // has at least one separator
      !/[<>:"|?*\u0000\r\n]/.test(t) && // avoid Windows-illegal and control chars
      !t.endsWith(':')                   // avoid bare "C:"
  ) return true

  return false
}

function validateLibrariesShallow(raw) {
  return Array.isArray(raw) && raw.every(s => {
    if (typeof s !== 'string') return false
    const t = s.trim()
    return !!t && looksLikePath(t)
  })
}

// Folder tab
const currentPath = ref('')

// Switch tabs to the Libraries tab (adjust name to your actual tab key)
function openLibrariesTab() {
  try {
    activeSettingPanel.value = 'libraries'
  } catch (_) {
  }
}

async function addLibraries() {
  try {
    const path = await ipcRenderer.invoke('select-folder', t('m.library'))
    if (!path) return

    const list = workingLibraries.value || []
    const i = list.findIndex(x => x?.path === path)

    if (i >= 0) {
      // already there: mark as exists (useful if it was missing before)
      list[i] = { ...list[i], exists: true }
    } else {
      list.push({ path: path, exists: true })
    }
    workingLibraries.value = [...list]

  } catch (e) {
    ElMessage.error(e?.message || 'Failed to add folders')
  }
}

async function checkLibraryFoldersMissing(paths) {
  try {
    const res = await ipcRenderer.invoke('fs:exists-batch', paths) // [{ path, exists }]
    const existsByPath = new Map(res.map(x => [x.path, !!x.exists]))
    return paths.map(p => ({ path: p, exists: !!existsByPath.get(p) }))
  } catch {
    return paths.map(p => ({ path: p, exists: false }))
  }
}

function onRowSelect(row) {
  currentPath.value = row?.path || ''
}

function removeAt(i) {
  workingLibraries.value = (workingLibraries.value || []).filter((_, idx) => idx !== i)
}

function saveLibraries() {
  const paths = (workingLibraries.value || []).map(x => x.path)
  setting.value.libraries = Array.from(new Set(paths))
  saveSetting()
  ElMessage.success(t('m.saved') || 'Saved')
  dialogVisibleSetting.value = false
}

async function resetWorkingLibraries() {
  const paths = [...(setting.value.libraries || [])]
  workingLibraries.value = await checkLibraryFoldersMissing(paths)
}

async function openInOS() {
  if (currentPath.value) {
    await ipcRenderer.invoke('show-folder', currentPath.value)
  }
}

/** -------------------------------------------
 * Library Folder Management End
 */

/*          Batch Metadata Update Config
 * -------------------------------------------
 */


/** Scope control: 'no-tag' | 'all' */
const scope = ref('no-tag')


/** Public API config */
const api = ref({
  igneous: '',
  ipb_member_id: '',
  ipb_pass_hash: '',
  star: '',
})


const apiStatus = ref({ type: 'info', text: 'Ready ?' }) // success | warning | danger | info

/** Offline SQLite config */
const offlineStatus = ref({
  file: { type: 'warning', text: 'Missing' },     // success|warning|danger
  db: { type: 'warning', text: 'Not initialized' },
})


/** Derived: is Start enabled? */
function canStart() {
  const s = setting.value
  return !!(s.batchUpdateApiEnabled || s.batchUpdateDBEnabled || s.batchUpdateEHViewerEnabled)
}

async function isPublicAIPReady() {
  try {
    const res = await ipcRenderer.invoke('get-ex-webpage', { url: 'https://exhentai.org/', cookie: cookie.value })
    if (res) {
      console.log('testPublicAPI: got response')
      return true
    } else {
      return false
    }
  } catch (e) {
    console.log(e)
    return false
  }
}


/** Actions */
async function testPublicAPI() {
  // Do a lightweight call; set apiStatus.value accordingly
  if (setting.value.igneous && setting.value.ipb_member_id && setting.value.ipb_pass_hash && setting.value.star) {
    if (await isPublicAIPReady()) {
      apiStatus.value = { type: 'success', text: 'Ready' }
    } else {
      apiStatus.value = { type: 'warning', text: 'Connection failed' }
    }
  } else {
    console.log('testPublicAPI: missing config')
    apiStatus.value = { type: 'info', text: 'Not Configured' }
  }
  return apiStatus.value.type === 'success'
  // Example failure:
  // apiStatus.value = { type: 'danger', text: 'Invalid/Expired' }
}

/* ------------------------------
   OFFLINE (SQLite) helpers
--------------------------------*/

const offlineBusy = ref(false)
const offlineDbState = reactive({
  // per path: { exists: true|false|null, inited/isValid: true|false|null }
  byPath: Object.create(null),
})

const offlineDbRows = computed(() =>
    ([...new Set(setting.value.apiDumpDbPaths || [])]).map(p => ({
      path: p,
      exists: offlineDbState.byPath[p]?.exists ?? null,
      isInit: offlineDbState.byPath[p]?.isInit ?? null,
      isValid: offlineDbState.byPath[p]?.isValid ?? null,
      running: offlineDbState.byPath[p]?.running ?? false
    }))
)


async function AddApiDumpDB() {
  const path = await ipcRenderer.invoke('select-file', t('m.selectApiDump'))
  if (path) {
    if (!setting.value.apiDumpDbPaths.includes(path)) {
      setting.value.apiDumpDbPaths.push(path)
      saveSetting()
    }
  }
}

function removeDb(path) {
  const i = setting.value.apiDumpDbPaths.indexOf(path)
  if (i >= 0) setting.value.apiDumpDbPaths.splice(i, 1)
  saveSetting()
}

/** QUICK TEST: fast checks only (file exists? openable? required tables?) */
async function testOfflineDb() {

  if (!setting.value.apiDumpDbPaths) {
    return false
  }

  const results = await ipcRenderer.invoke('fs:exists-batch', [...(setting.value.apiDumpDbPaths) || []]) // [{ path, exists }]
  for (const { path, exists } of results) {
    if (!offlineDbState.byPath[path]) {
      offlineDbState.byPath[path] = {}
    }
    let isInited = null
    let isValidDb = null
    if (exists) {
      try {
        ({ isValidDb, isInited } = await ipcRenderer.invoke('matcher:db-init', path, true))
      } catch {}
    }
    offlineDbState.byPath[path] = {
      exists: exists,
      isInit: isInited,
      isValid: isValidDb
    }
  }
  return offlineDbRows.value.some(x => x.isInit === true)
}

/** INITIALIZE: heavy step (~1 min). Shows inline spinner; auto-tests on success. */
async function initOfflineDb(row = null) {
  if (offlineBusy.value) return
  offlineBusy.value = true
  const dbPathList = row ? [row] : offlineDbRows.value

  for (const r of dbPathList) {
    if (!offlineDbState.byPath[r.path]) {
      offlineDbState.byPath[r.path] = {}
    }
    try {
      offlineDbState.byPath[r.path].running = true
      const isInit = await ipcRenderer.invoke('matcher:db-init', r.path, false)
      offlineDbState.byPath[r.path].isInit = isInit ? isInit : 'failed'
      offlineDbState.byPath[r.path].isValid = true
    } catch (e) {
      console.log('initOfflineDb Error: ', e)
    }
    offlineDbState.byPath[r.path].running = false

  }

  offlineBusy.value = false

}


/** (Optional) If you receive file mtime from elsewhere, invalidate when changed */

const startBusy = ref(false)

async function onStart() {
  startBusy.value = true
  const s = setting.value
  if (s.batchUpdateApiEnabled) {
    if (await testPublicAPI()) {
      console.log('testPublicAPI: success')
    }
  } else {
    console.log('onStart: no api enabled')
  }
  if (s.batchUpdateDBEnabled) {
    offlineBusy.value = true
    if (await testOfflineDb()) { // check whether at least one db is valid
      const validPaths = offlineDbRows.value.filter(x => x.isInit === true).map(x => x.path)
      await ipcRenderer.invoke('matcher:db-match', validPaths)
      console.log('onStart: offline db is ready')

    } else {
      console.log('initOfflineDb is not available')
    }
    offlineBusy.value = false
  }
  startBusy.value = false

  // Emit or call your batch runner; progress handled elsewhere
  // payload suggestion:
  // {
  //   scope: scope.value,
  //   methods: {
  //     api: enabled.value.api,
  //     offline: enabled.value.offline,
  //     local: enabled.value.local
  //   },
  //   api: api.value,
  //   offlinePath: offline.value.path
  // }
}

/** Auto-save: watch and persist changes as needed (stub) */
// watch([api, offline, enabled, scope], () => {
// persist to store or disk
// })


/** -------------------------------------------
 * Batch Metadata Update Config End
 */


const selectMetadataPath = () => {
  ipcRenderer.invoke('select-folder', t('m.metadataPath')).then(res => {
    setting.value.metadataPath = res
    saveSetting()
  })
}

const selectImageExplorerPath = () => {
  ipcRenderer.invoke('select-file', t('m.imageViewer')).then(res => {
    if (res) {
      setting.value.imageExplorer = `"${res}"`
      saveSetting()
    }
  })
}


// Turn the GitHub payload { data: { cat: { data: { key: {name,intro} } } } }
// into a flat { key: { name, intro } } map.
function toFlatMap(json) {
  const out = {}
  const root = json?.data || {}
  for (const cat of Object.values(root)) {
    const d = cat?.data || {}
    for (const [k, v] of Object.entries(d)) {
      out[k] = { name: v?.name, intro: v?.intro }
    }
  }
  return out
}

async function loadTranslationFromEhTagTranslation() {
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000 //~ 30 days
  const now = Date.now()
  const cached = JSON.parse(localStorage.getItem('translationCache') || 'null')

  // Helper to commit the in-memory value + cache + notify
  const commit = (ts, flat) => {
    resolvedTranslation.value = flat
    localStorage.setItem('translationCache', JSON.stringify({ ts, data: flat }))
    ipcRenderer.invoke('update-tag-translation', flat).catch(() => {})
    return flat
  }

  // 1) If cache exists and is fresh → use it
  if (cached?.data && (now - (cached.ts || 0) < ONE_MONTH_MS)) {
    return commit(cached.ts, cached.data)
  }

  // 2) If cache is null → try local file
  if (!cached) {
    try {
      const resp = await ipcRenderer.invoke('read-json-with-stat', {
        dirname: 'translation',
        filename: 'db.text.json',
      })
      if (resp?.ok && (now - (resp.mtimeMs || 0) < ONE_MONTH_MS)) {
        const flat = toFlatMap(resp.json)
        return commit(resp.mtimeMs || now, flat)
      }
    } catch {}
    // fall through to download if file missing or stale
  }

  // 3) Download latest, save to disk, parse, cache
  throw new Error('Debug: Translation not found')
  // TODO: remove the throw

  const raw = await ipcRenderer.invoke('download-tag-translation-file') // returns parsed JSON
  await ipcRenderer.invoke('save-file', {
    dirname: 'translation',
    filename: 'db.text.json',
    content: JSON.stringify(raw, null, 2),
  })
  const flat = toFlatMap(raw)
  return commit(Date.now(), flat)
}

const handleTranslationSettingChange = (val) => {
  if (val) {
    loadTranslationFromEhTagTranslation()
  } else {
    resolvedTranslation.value = {}
  }
  saveSetting()
}

const testProxy = async () => {
  await fetch('https://e-hentai.org').then((res) => {
    if (res.status === 200) {
      printMessage('success', t('c.proxyWorking'))
    } else {
      printMessage('error', `Error ${res.status}: ` + t('c.proxyNotWorking'))
    }
  }).catch((error) => {
    printMessage('error', t('c.proxyNotWorking'))
  })
}

const autoCheckUpdates = async (forceShowDialog) => {
  await fetch('https://api.github.com/repos/SchneeHertz/exhentai-manga-manager/releases/latest', {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + gh_token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }).then(res => res.json()).then(res => {
    const { tag_name, html_url, body } = res
    const skipVersion = localStorage.getItem('skipVersion')
    if (tag_name && tag_name !== 'v' + version && tag_name !== skipVersion) {
      ElMessageBox.confirm(
          h('pre', { innerHTML: body, style: 'font-family: Avenir, Helvetica, Arial, sans-serif' }),
          t('c.newVersion') + tag_name,
          {
            distinguishCancelAndClose: true,
            confirmButtonText: t('c.downloadUpdate'),
            cancelButtonText: t('c.skipVersion'),
          },
      ).then(() => {
        ipcRenderer.invoke('open-url', html_url)
      }).catch((action) => {
        if (action === 'cancel') {
          localStorage.setItem('skipVersion', tag_name)
        }
      })
    } else if (forceShowDialog) {
      ElMessageBox.confirm(
          t('c.notNewVersion'),
          {
            type: 'info',
            showCancelButton: false,
          },
      )
    }
  })
}

const handleThemeChange = (val) => {
  changeTheme(val)
  saveSetting()
}
const changeTheme = (classValue) => {
  document.documentElement.setAttribute('class', classValue)
}
const handleLanguageChange = (val) => {
  ipcRenderer.invoke('get-locale').then(localeString => {
    let languageCode
    if (!val || (val === 'default')) {
      languageCode = localeString
    } else {
      languageCode = val
    }
    handleLanguageSet(languageCode)
    saveSetting()
  })
}

const saveSetting = () => {
  ipcRenderer.invoke('save-setting', _.cloneDeep(setting.value))
}

const openLink = (link) => {
  ipcRenderer.invoke('open-url', link)
}

const forceGeneBookList = async () => {
  dialogVisibleSetting.value = false
  localStorage.setItem('viewerReadingProgress', JSON.stringify([]))
  bookList.value = await ipcRenderer.invoke('force-gene-book-list')
  emit('loadCollectionList')
  printMessage('success', t('c.rebuildMessage'))
}
const patchLocalMetadata = async () => {
  await ipcRenderer.invoke('patch-local-metadata')
  emit('loadBookList')
}
const handleLanguageSet = (languageCode) => {
  switch (languageCode) {
    case 'zh-CN':
      localeFile.value = zhCn
      locale.value = 'zh-CN'
      break
    case 'zh-TW':
      localeFile.value = zhTw
      locale.value = 'zh-TW'
      break
    case 'en-US':
    default:
      localeFile.value = en
      locale.value = 'en-US'
      break
  }
}

const exportDatabase = async () => {
  const folder = await ipcRenderer.invoke('select-folder', t('c.exportFdownload-tag-translation-fileolder'))
  const result = await ipcRenderer.invoke('export-database', folder)
  if (result) printMessage('success', t('c.exportMessage'))
}

const importDatabase = async () => {
  const collectionListPath = await ipcRenderer.invoke('select-file', t('c.selectCollectionList'),
      [{ name: 'JSON', extensions: ['json'] }])
  const metadataSqlitePath = await ipcRenderer.invoke('select-file', t('c.selectMetadataSqlite'),
      [{ name: 'SQLite', extensions: ['sqlite'] }])
  await ipcRenderer.invoke('import-database', { collectionListPath, metadataSqlitePath })
}

const importMetadataFromSqlite = async () => {
  const { success } = await ipcRenderer.invoke('import-sqlite')
  if (success) {
    printMessage('success', t('c.importMessage'))
  } else {
    printMessage('info', t('c.canceled'))
  }
}
// TODO: check all argument inputs that use cloneDeep; seems expensive to clone twice
const _importMetadataFromSqlite = async () => {
  const { success, bList } = await ipcRenderer.invoke('import-sqlite', _.cloneDeep(bookList.value))
  if (success) {
    bookList.value = bList
    printMessage('success', t('c.importMessage'))
  } else {
    printMessage('info', t('c.canceled'))
  }
}

const busyRemove = ref(false)
const removeMissingRecords = async () => {
  const ipc = window.electron?.ipcRenderer ?? window.ipcRenderer
  if (!ipc) {
    // just in case
    ElMessage.error('IPC not available')
    return
  }
  busyRemove.value = true
  try {
    // 1) Dry run — get counts
    const { totalRows, missingFileCount, missingCoverCount } =
        await ipc.invoke('remove-missing-records')

    let mainFreeMB, mainPct, metaFreeMB, metaPct = null

    try {
      const est = await ipc.invoke('sqlite-vacuum-estimate') // optional IPC
      if (est?.main) {
        mainFreeMB = String(est.main.freeMB)           // already MB
        mainPct = est.main.freeRatio != null ? String((est.main.freeRatio * 100).toFixed(1)) : null
      }
      if (est?.meta) {
        metaFreeMB = String(est.meta.freeMB)
        metaPct = est.meta.freeRatio != null ? String((est.meta.freeRatio * 100).toFixed(1)) : null
      }
    } catch { /* IPC not implemented — ignore */ }
    const pieces = []
    if (mainFreeMB) pieces.push(`database.sqlite: ${mainFreeMB} MB ${mainPct ? ` (${mainPct}%)` : ''}`)
    if (metaFreeMB) pieces.push(`metadata.sqlite: ${metaFreeMB} MB ${metaPct ? ` (${metaPct}%)` : ''}`)
    const estimateText = pieces.length ? t('m.mayFree', { sizes: pieces.join(', ') }) : ''
    const vacuumLine = `
  <p style="margin-top:8px">
    <label style="display:flex;gap:8px;align-items:center">
      <input id="vacuumOpt" type="checkbox" />
      <span>
        ${t('m.vacuumAlso')}
        <span style="opacity:.8">${t('m.vacuumEstimate', { estimate: estimateText })}</span>
      </span>
    </label>
  </p>`


    // 2) Ask for confirmation
    const msg = `
  <div>
    <p>${t('m.confirmRemoveIntro')}</p>
    <ul style="margin:8px 0 0 18px;padding:0;line-height:1.6">
      <li>${t('m.totalRecordsScanned')}: <b>${totalRows}</b></li>
      <li>${t('m.missingFilesToRemove')}: <b>${missingFileCount}</b></li>
      <li>${t('m.unrefCoversToDelete')}: <b>${missingCoverCount}</b></li>
    </ul>
    <p style="margin-top:8px"><b>${t('m.noFilesDeleted')}</b></p>
    ${vacuumLine}
    <p style="opacity:.8">${t('m.actionIrreversible')}</p>
  </div>`

    let wantVacuum = false
    await ElMessageBox.confirm(msg, t('m.confirmRemoveTitle'), {
      dangerouslyUseHTMLString: true,
      type: 'warning',
      cancelButtonText: t('m.cancel'),
      confirmButtonText: t('m.remove'),
      // read checkbox before dialog closes
      beforeClose: (action, _instance, done) => {
        if (action === 'confirm') {
          const cb = document.getElementById('vacuumOpt')
          wantVacuum = !!cb?.checked
        }
        done()
      },
    })

    // 3) Execute cleanup
    const res = await ipc.invoke('remove-missing-records', { confirm: true, vacuum: wantVacuum })
    // res may include counts if you returned them; keep message simple:
    emit('loadBookList')
    ElMessage.success('Cleanup complete. Re-scanning...')
  } catch (err) {
    // ElMessageBox.confirm throws on cancel; swallow it quietly
  } finally {
    busyRemove.value = false
  }
}

const formTagAdd = ref({
  tag: null,
  color: '#42A5F5',
})

const tagListForCollect = computed(() => {
  if (setting.value.showTranslation) {
    return tagListRaw.value.map(({ letter, cat, tag, id }) => {
      const labelHeader = cat === 'group' ? '团队' : resolvedTranslation.value[cat]?.name || cat
      const labelTail = resolvedTranslation.value[tag]?.name || tag
      return {
        label: `${labelHeader}:${labelTail} || ${letter}:"${tag}"$`,
        value: id,
      }
    })
  } else {
    return tagListRaw.value.map(({ letter, cat, tag, id }) => {
      return {
        label: `${cat}:${tag} || ${letter}:"${tag}"$`,
        value: id,
      }
    })
  }
})

const moderateSoftColors = [
  '#FF6F61', // 略微柔和但鲜艳的珊瑚红
  '#F48FB1', // 鲜明的粉红色
  '#42A5F5', // 鲜艳的蓝色
  '#66BB6A', // 鲜艳的绿色
  '#FFCA28', // 亮黄色
  '#AB47BC', // 鲜亮的紫色
  '#26A69A', // 热带青色
  '#FFA726', // 鲜亮的橙色
  '#8D6E63', // 保存自然的棕色
  '#78909C',  // 鲜明的灰蓝色
]

const addTagToCollect = () => {
  const tag = tagListRaw.value.find(tag => tag.id === formTagAdd.value.tag)
  if (!setting.value.collectTag) setting.value.collectTag = []
  setting.value.collectTag.push({
    id: tag.id,
    letter: tag.letter,
    cat: tag.cat,
    tag: tag.tag,
    color: formTagAdd.value.color,
  })
  setting.value.collectTag = _.uniqBy(setting.value.collectTag, 'id')
  formTagAdd.value.tag = null
  saveSetting()
}

const removeTag = (id) => {
  setting.value.collectTag = setting.value.collectTag.filter(tag => tag.id !== id)
  saveSetting()
}

const reloadWindow = () => {
  window.location.reload()
}

async function onSettingOpen() {
  await nextTick()
  await resetWorkingLibraries()
}

defineExpose({
  dialogVisibleSetting,
  activeSettingPanel,
  saveSetting,
})

</script>

<style lang="stylus">
.setting-title
  margin: 0
  text-align: center

.setting-line
  margin: 6px 0

  .el-input-group__prepend
    width: 110px

.setting-line.regexp
  .el-input__inner
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace

.setting-line.collect-tag
  .el-form-item
    margin-bottom: 0

  .el-tag
    margin-right: 8px
    margin-bottom: 8px
    border-width: 0

.setting-switch
  text-align: left
  margin-top: 6px

.label-input > .el-input__wrapper
  display: none

.label-input
  .el-input-group__append
    width: 77% // align the dropdown text placeholder (a breaking change after electron 30.0.0)
    background-color: transparent
    border-left: solid 1px var(--el-border-color)

    .el-select
      width: 100%

.about-logo
  width: 160px
  position: absolute
  right: 40px
  top: 10px

.setting-tabs
  .el-tabs__content
    max-height: 70vh
    overflow-y: auto
    padding-right: 10px


.setting-line--concurrency .label-input {
  width: 100%;
}

/* Align the right gray divider with the row above */
.setting-line--concurrency .label-input .el-input-group__prepend {
  width: var(--setting-label-width);
  flex: 0 0 var(--setting-label-width);
  max-width: var(--setting-label-width);

  box-sizing: border-box; /* include border in width calc */
  padding: 0 29px; /* mirror your other row’s padding */
  display: flex;
  align-items: center;

  /* ensure the divider exists/looks identical */
  border-right: 1px solid var(--el-border-color);
}

.setting-label-wide {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* add any special tweaks unique to this row here */
}

// library folders in the setting tab
/* 0) Make sure the hidden text input doesn't push layout */
.lib-input .el-input__inner {
  flex: 0 0 auto !important;
  width: 0 !important;
  padding: 0 !important;
  border: none !important;
}

/* 1) Let the suffix stretch and center its single child vertically */
.lib-input .el-input__suffix,
.lib-input .el-input__suffix-inner {
  display: flex;
  flex: 1 1 0%;
  min-width: 0;
  align-items: center; /* <-- center across the row height */
  justify-content: flex-start;
}

/* 2) Give the preview area a fixed visible height (≈ 2 tag rows) and
      center its content vertically */
.lib-preview {
  display: flex;
  align-items: center; /* <-- centers the .el-space block vertically */
  height: 33px; /* adjust to 56/64/72px to fit your tag size */
  width: 100%;
}

/* 3) The actual tag list (Element Plus <el-space>) — wrap rows, but
      do NOT stretch to full height so it can be centered by its parent */
.lib-preview .el-space {
  flex-wrap: wrap !important;
  align-items: center !important; /* center items within each row */
  gap: 8px !important;
  align-self: center; /* ensure the block participates in centering */
  justify-content: flex-start !important; /* <-- left start */
  /* no fixed height here */
  margin-left: 0 !important; /* guard against accidental centering */
}

.lib-input .el-input__suffix-inner > :first-child {
  margin-left: 0 !important;
}

/* (Optional) keep the Manage button aligned like other lines */
.lib-input .el-input-group__append {
  display: flex;
  align-items: center;
  padding: 0 18px;
}

.lib-preview .el-tag {
  max-width: 240px;
  --el-tag-font-size: 13px;
}

.lib-preview .el-tag__content {
  max-width: 100%;
}

/* cut off on one line with … */
.chunk-path {
  display: inline-block;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

// library tab
.libpath {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

.lib-line {
  display: flex;
  align-items: center;
  justify-content: space-between; /* label left, buttons right */
}


/* batch metadata update */
.setting-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.setting-title {
  margin: 0 0 4px 0;
  font-weight: 600;
}
.count-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.card-hd {
  display: flex;
  align-items: center;
}
.spacer {
  flex: 1;
}
.method-footer {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.hint {
  opacity: 0.8;
  font-size: 12px;
}
.muted {
  opacity: 0.7;
  font-size: 12px;
}
.tr {
  text-align: right;
}
.mb8 {
  margin-bottom: 8px;
}
.mb16 {
  margin-bottom: 16px;
}
.mt8 {
  margin-top: 8px;
}
.mr4 {
  margin-right: 4px;
}
.mr8 {
  margin-right: 8px;
}
.ml8 {
  margin-left: 8px;
}
.compact-alert :deep(.el-alert__description) {
  margin-top: 4px;
}
.scope-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.scope-label {
  font-weight: 500;
}
.scope-hint {
  font-size: 12px;
  opacity: 0.8;
}
.actions-row {
  margin-top: 8px;
}

.update-method .el-input .el-input-group__prepend {
  width: 70px; /* pick a width that fits your longest label */
  display: inline-flex;
  align-items: center;
  white-space: nowrap;

}
/* Button group spacing */
.el-form-item.lib-line {
  padding: 0;
  width: 100%;
}

.el-table .col-right .cell {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px; /* nice spacing if multiple items appear */
}

.el-table th.col-right > .cell {
  justify-content: center
}

/* Wrap long segments and paths nicely */
.el-table .col-path .libpath {
  display: inline;
  white-space: normal;
  word-break: break-word; /* fallback */
  overflow-wrap: anywhere; /* modern browsers */
  line-height: 1.2;
}

/* Optional: prevent the right-fixed columns from shrinking the path */
.el-table .col-path {
  min-width: 240px; /* adjust as needed */
}

.el-table .col-path .cell {
  display: block; /* break out of flex so text can wrap */
  white-space: normal; /* allow line breaks */
  overflow: visible;
}

/* Thicker left divider on the index column (header + body) */
.el-table th.col-index.el-table__cell,
.el-table td.col-index.el-table__cell {
  border-left-width: 5px; /* make it broader */
  border-left-style: solid;
  border-left-color: var(--el-border-color);
  /* optional: extra left padding to match the Actions side spacing */
  padding-left: 3px;
}


</style>