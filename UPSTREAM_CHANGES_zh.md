# 上游变更

## Bug修复

### 启动时设置写入竞争/损坏

- **问题：** 多次调用 `save-setting` 可能会损坏 `setting.json`（如启动时或切换语言时）。
- **修复：** 合并写入 (Coalesce writes)；最后一次写入优先，但会保留缺失的设置。先写入 `setting.json.tmp`，然后重命名。
- **复现：** 在设置页面，`Trim Title RegExp` 总是为空，因为并发保存。
- **补丁：** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L1409-L1484)

### 7z的UTF-8编码与特殊文件名

- **问题：** 非ASCII名称和以 `-` 开头的文件名在导致7z解压失败。
- **修复：** 给7z参数添加 `-sccUTF-8` 和 `--`；输出解码为UTF-8。
- **复现：** 用日文子文件夹和名为 `-abc.jpg` 的文件压缩文件夹。调用7z时失败。
- **补丁：** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/fileLoader/archive.js#L29-L30)

### 扫描时重复文件处理

- **问题：** 扫描(Scan)与强制重建(Forced Rebuild)时重复文件处理不一致。
- **修复：** 发现重复时，使用数据库中的文件路径验证其存在性。如果不存在，则视为已迁移；否则作为新文件添加。
- **复现：** 将文件复制到两个文件夹；扫描和强制重建结果不同。
- **补丁：** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L683-L690)

### 其他小修复

- `resultLists` 可能为undefined [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L217-L220)
- `callback` 可能为undefined  [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L238-L239)
- `collectionList` 可能不是数组 [code1](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L1151-L1152), [code2](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L1198-L1199)

### 其他

- 在 `getBookInfoFromHentag` 中，使用 `category: categoryOption.value[data.category-1]`（索引从0开始）。[code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L96-L97) .

## 改进

### 并行扫描/重建/补丁，限速与中止

- **内容：** 对读取压缩包和写入封面缩略图进行并发控制；批量数据库提交；可中止任务。
- **设计：**
  - 文件分批处理；每批内：
    - 启动多个 `7z` (`-mmt=1`) 进程将文件加载到内存。
    - 用单独队列写入封面到磁盘。
    - 每批结束时提交数据库。
  - 中止控制器可取消正在进行的任务。
  - 设置页面新UI：并发读取（解压文件）和写入（封面缩略图）。默认值保守（读=4或最大CPU，写=2或最大CPU）。
  - 扫描时检查书籍是否存在；若缺失则分配“缺失”类别。
- **结果：**
  - 强制重建含360文件（43.3GB）的库。App/dbs/cover文件夹在SSD；库文件夹在7200rpm CMR HDD。

    <div style="text-align:center; margin-left:25%">

    | 读  | 写 | 时间(s)   |
    | --- | --- | --------- |
    | 4   | 2   | 21.77     |
    | 4   | 4   | 19.36     |
    | 6   | 4   | 14.13     |
    | 8   | 2   | 15.90     |
    | **8** | **4** | **11.36** |
    | 8   | 8   | 11.28     |
    | 16  | 4   | 11.10     |
    | 16  | 16  | 11.84     |

     </div>

  - 更高的扫描/读取值未必提升性能，因封面写入和数据库提交成为瓶颈。
  - 在HDD上扫描28,521文件（2.68TB）：8读/4写≈2816s，4读/2写≈2732s

- **注意：** 某些杀毒软件会在进程退出后并行重新扫描所有被操作的文件，导致磁盘持续高负载。如Norton用 `aswidsagent.exe` 扫描所有被7z操作的文件，且无法关闭。长时间运行时建议将大型库文件夹加入白名单。
- **补丁：**  
  - [Aborter](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L575-L616)
  - [Extract files to RAM](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L515-L516)
  - [`load-book-list`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L620-L621)
  - [`force-gene-book-list`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L789-L790)
  - [`patch-local-metadata`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L911-L912)

### 启动加速（SQL）

- **内容：** 在 `loadBookListFromDatabase` 中用SQL查询替换JS循环。
- **结果：** 28,521文件：启动时间从3.61s降至0.39s。
- **补丁：** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L319-L320)

## 分片封面文件夹

- **内容：** 用封面哈希前两位十六进制分256子文件夹；文件名为 `sha256(imageBuffer).webp`。
- **原因：** 单一大目录导致枚举和清理变慢。
- **方法：**
  - 新路径：`cover/<hh><hash>.webp`，`<hh>`为哈希前两位。
  - 数据库存储封面哈希，迁移简单。
- **补丁** [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/fileLoader/index.js#L145-L146)

## 更快的库树

- **内容：** 用二分查找构建文件夹树。
- **方法：**
  - 路径排序和索引。
  - 计算并缓存上下界索引。
  - 用二分查找列出指定文件夹下所有书籍。
- **结果：** 点击文件夹显示所有书籍时，数据库有28K行时新方法比旧方法快约2秒。
- **补丁：** `FolderTree.vue`
  - [build tree](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L235-L236)
  - [list files for a folder](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L418-L419)

## 新分类搜索模式

- **内容：** 用 `cat:category$` 在搜索对话框筛选分类。
- **原因：** 现有设计用 `category$`，会包含标题匹配分类名的书籍。
- **补丁：**   [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L967-L974)

## 新UI功能

### 标签更新内置浏览器

- **内容：** 内嵌浏览器直接访问网站并应用标签。
- **原因：** 现有搜索对话框只显示标题，结果常缺失。
- **设计：**
  - 从书籍详情“手动获取元数据”打开。
  - 内置广告拦截；可编辑URL栏显示当前页面；确认按钮在支持的URL模式下激活。
    - ehentai: <https://e-hentai.org/g/{gallery_id}/{gallery_token}/>
    - exhentai: <https://exhentai.org/g/{gallery_id}/{gallery_token}/>
    - nhentai: <https://exhentai.org/g/{gallery_id}>
    - hentag: <https://hentag.com/vault/>
    - panda chaika: 将 `Source metadata` 粘贴到URL栏
  - 确认按钮：更新所有漫画标签。eh/ex/hentag用公共API；nhentai用内置爬虫。
  - 更新分类/作者/社团/角色按钮：ex/ehentai URL激活；无精确匹配时有用。
  - 需登录e-hentai才能访问exhentai。登录状态持久化。
- **补丁：**
  - UI: [SearchDialogBrowser.vue](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialogBrowser.vue#L1)
  - Parent node:  [SearchDialog.vue](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/SearchDialog.vue#L2)

### 设置：移除缺失记录

- **内容：** 按钮移除数据库缺失记录和未引用封面文件。
- **原因：** 现有设计每次扫描库时移除缺失记录，库文件夹配置错误时易误删。
- **设计：**
  - 按钮在设置→高级。
  - 点击后验证数据库所有书籍是否存在，标记缺失项，并缓存所有未被引用的封面缩略图。
  - 弹窗显示缺失书籍数、未引用封面数、数据库真空选项和确认按钮。
- **补丁**
  - [UI](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L563-L565)
  - [On click](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L1081-L1163)
  - [ipcMain](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L1634-L1793)

### 设置：库文件夹管理

- **内容：** 设置页可添加/移除库文件夹。
- **原因：** 现有设计只允许单一库根，新设计便于管理多个库文件夹。
- **设计：**
  - 设置页General标签显示库文件夹，带管理按钮。
  - 管理库标签页可添加/移除文件夹。
  - `setting.json` 新增 `'libraries': [path string]`
  - 更新 `scanLibraryFilesWithExclude` 支持多库文件夹。
- **补丁：**
  - [Library folders in the general tab](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L17-L88)
  - [Manage Library Tab](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/Setting.vue#L155-L230)

### 侧边栏：文件夹树/作者/社团/Parody标签

- **内容：** 文件夹树支持多库文件夹；新标签页快速访问作者、社团、恶搞。
- **原因：**
  - 旧文件夹树只允许一个库文件夹，管理多库不便。
  - 主窗口有标签/作者快捷方式，但不支持全库。
- **设计：**
  - 文件夹树：
    - 顶部“All”节点显示所有书籍。
    - 展开/收起所有节点按钮。
    - 仅有一个子文件夹且无文件时收起顶层节点。
  - 作者/社团/Parody标签页：
    - 点击标签显示所有作者/社团/恶搞。
    - 点击项在主窗口显示书籍。
    - 按En/Jp/Zh/数量排序。
    - 按En/Jp/Zh搜索。
- **补丁：** [`FolderTree.vue`](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/FolderTree.vue#L1)
  
### 移动文件：移动文件对话框

- **内容：** 新对话框选择文件移动目标文件夹。
- **原因：** 子文件夹多时难以选择目标。
- **设计：**
  - 用系统文件管理器（`ipcMain.handle('select-folder')`）选文件夹。
  - 文件可移动到任意文件夹，不限于库文件夹。
- **补丁：**
  - [UI](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/MoveFileDialog.vue#L1)
  - [Usage in parent node](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L194-L205)

## UI微调

- 缺失文件分配“缺失”状态  [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L410-L426)
- E-Hentai风格分类标签，保留 `tag-failed` 和 `non-tag` [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/BookCard.vue#L128-L140)
- “缺失”分类用于缺失文件。每次扫描都验证文件存在。[code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/index.js#L406-L407)
- `No Tag Only` [过滤器](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L54-L55)  
- 书籍详情（编辑标签）列出默认标签 [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/components/BookDetailDialog.vue#L328-L339)
- 鼠标前进/后退导航 [code](https://github.com/yu45020/exhentai-manga-manager/blob/5aa62b9c2113fb6569cfccabd10169e8202820f3/src/App.vue#L619-L641)
  - `home` UI：
    - a. 后退按钮：
      - 当前页为首页时重置（同原行为）
      - 否则返回上一页
    - b. 前进按钮：如有下一页则前进
  - `bookdetail` UI：
    - a. 后退按钮：关闭书籍详情UI
    - b. 前进按钮：如有则查看下一个书籍详情
- Electron ≥ 30后设置页UI对齐
- 默认隐藏评论

## 环境

- Windows 11
- 应用版本：1.6.10
- 上游提交：23dc690c（2025年8月8日）
