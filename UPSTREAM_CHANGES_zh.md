# 自上游仓库的变更（23dc690c · 2025-08-08）

## Bug 修复

1. 启动时设置写入可能发生竞争/损坏
    - **What：** 当在短时间内多次调用 `save-setting`（应用启动），避免 `setting.json` 被部分写入或截断。
    - **Why：** 并发写入时，如果进程在写入中途退出/崩溃，可能留下半写入的 JSON 文件；下次启动会导致设置丢失。
    - **How：**
      - **合并写入（coalesce）**：最后一次写入生效，但后一次缺失的字段不会覆盖先前已存在的字段。
      - 先写入 `setting.json.tmp`，随后在同一文件系统上使用**原子重命名**为 `setting.json`。
    - **Reproduce（复现）：**
      - 在设置页中，`Trim Title RegExp` 总是显示为空。
      - 原因：在 `onMounted` 中，该变量不在默认设置里，却被赋值后立刻调用 `save-setting`；同时 `handleLanguageChange` 也会调用 `save-setting`（[代码] (link)）。
    - **Patch：** [commit 1](link)

2. 使用 7z 时的 UTF-8 编解码与特殊文件名
    - **What：** 在调用 7z 时，正确处理非 ASCII 名称以及以特殊字符开头的文件名。
    - **Why：** 当压缩包包含日文名或形如 `-abc.jpg` 的文件时，首次 7z 尝试会失败并回退到 `AdmZip`。
    - **How：**
        - 向 7z 添加 `-sccUTF-8` 强制使用 UTF‑8。
        - 插入 `--` 标记选项结束，避免以 `-` 开头的文件名被识别为参数。
        - 仅以 UTF‑8 解码子进程输出。
    - **Reproduce：**
        - 添加一个包含日文文件夹名的 zip；在其中加入文件 `-abc.jpg`。
        - 控制台可见 `reload ${filepath} use adm-zip`，说明首次 7z 失败。
    - **Patch：** [commit 2](link)

3. 扫描时的重复文件处理
    - **What：** 若数据库中该内容哈希对应的原路径已不存在，则将重复文件视为迁移/重定位(relocated)；否则视为新书目。
    - **Why：** 扫描(scan)会忽略重复项，而“强制重建” (forced rebuild) 会添加它们，导致结果不一致。
    - **How：** 当发现重复：
      - 若数据库记录的文件路径在磁盘上已不存在 → 更新路径（当作重定位）。
      - 否则 → 按新记录处理。
    - **Reproduce：**
      - 将同一文件复制到两个文件夹再扫描；程序仅新增 1 条记录。
      - 点击“强制重建”；此时两条记录都会添加。
    - **Patch：** [commit 3](link)

4. 无副作用的错误兜底
   - `resultLists` 可能为 `undefined`（[代码](link)）
   - `callback` 可能为 `undefined`（[代码](link)）
   - `collectionList` 可能不是数组（[代码](link)，[代码2](link)）

## 新功能

1. 内置浏览器用于更新标签（tags）
    - **What：** 内嵌浏览器，直接浏览站点并将标签应用到所选书目。
    - **Why：** 现有搜索对话框仅显示标题且结果常缺失。
    - **Design：**
      - 从“书目详情”界面的“手动获取元数据”打开。
      - 内置广告拦截；可编辑的地址栏显示当前页面；当 URL 匹配支持的模式时启用“确认”按钮。
        - e-hentai: `https://e-hentai.org/g/{gallery_id}/{gallery_token}/`
        - exhentai: `https://exhentai.org/g/{gallery_id}/{gallery_token}/`
        - nhentai: `https://exhentai.org/g/{gallery_id}`
        - hentag: `https://hentag.com/vault/`
        - panda chaika: 将“Source metadata”粘贴到地址栏
      - 点击“确认”后更新漫画标签：e-hentai / exhentai / hentag 使用公共 API；nhentai 使用内置爬虫。
      - 部分更新按钮（category/artist/group/cosplayer）在 URL 为 exhentai/e-hentai 时可用。
    - **How：**
      - 监听地址栏 `url` 变化；
      - **SearchDialogBrowser** 通过 `confirm` 事件向 **SearchDialog** 发送 `{bookDetail, url}`；
      - **SearchDialog** 中更新标签并写入数据库。
    - **Patch：** [commit 5](link)

2. 并行扫描/重建/打补丁：带并发限制与中止
    - **What：** 为读取与封面写入提供并发控制；批量数据库提交；可中止的任务。
    - **Why：** 在大型库上显著降低总耗时。
    - **Design：**
      - 将文件分块批处理；每批内：
        - 启动多个 `7z`（`-mmt=1`）将文件读入内存；
        - 封面缓冲写入使用独立队列；
        - 批末进行数据库提交；
      - 使用 AbortController 清理进行中的任务；
      - 设置页新增并发配置：并发读取（解压）与 并发写入（封面），默认较为保守（读=4 或 CPU 上限；写=2 或 CPU 上限）。
    - **实验数据：**
      - 重建 (forced rebuild) 360 个文件（43.3 GB）。文件库在 7200rpm CMR HDD；App/DB/封面保存在 SSD。

       | read | write | time(s) |
       |-----:|------:|--------:|
       | 4    | 2     | 21.77   |
       | 4    | 4     | 19.36   |
       | 6    | 4     | 14.13   |
       | 8    | 2     | 15.90   |
       | **8**| **4** | **11.36** |
       | 8    | 8     | 11.28   |
       | 16   | 4     | 11.10   |
       | 16   | 16    | 11.84   |

      - 更高的读取/扫描并发不一定更快，瓶颈在封面写入与批末数据库提交；
      - 扫描 28,521 个文件（2.68 TB）在 HDD：8r/4w ≈ 2816s，4r/2w ≈ 2732s。
    - **注意：** 某些杀软会在子进程退出后，**重新扫描所有被触及的文件**（可能并行），导致持续的磁盘噪音。例如Norton (aswidsagent.exe) 会扫描**所有**被 `7z` 访问的所有文件且无法关闭。扫描大目录时建议（若可能）将目录加入白名单。
    - **Patch：** [commit 7](link)
      - 新 UI：[`SearchDialogBrowser.vue`](src/components/SearchDialogBrowser.vue)
      - 更新：[`SearchDialog.vue`](src/components/SearchDialog.vue)

3. 通过 SQL 加速启动
   - **What：** 在 `loadBookListFromDatabase` 中，用 SQL 查询替换按行的 JS 循环。
   - **Why：** 大型库在启动时存在耗时的 JS 处理开销。
   - **How：** 用 SQL 替换 JS循环，直接从数据库合并和提取数据。
   - **Patch：** [commit 8](link)
   - **Test：** 28,521 个文件：启动时间从3.61s 降至 0.39s。

4. 封面目录分割
   - **What：** 使用封面哈希的前两位十六进制作为 256 个子目录；文件名为 `sha256(imageBuffer).webp`。
   - **Why：** 单目录在累计 ~3 万+ 文件后 (HDD)，删除文件时变慢。
   - **How：**
     - 新路径：`cover/<hh>/<hash>.webp`
     - 数据库存储封面哈希，迁移较为简单。

5. UI 微调
   - E‑Hentai 风格的分类标签，同时保留 `tag-failed` 与 `non-tag`。[commit 9](link)
   - 新增 `No Tag Only` filter。[commit 10](link)
   - 在“书目详情（编辑标签）”中展示默认标签分类。[commit 11](link)
   - 鼠标前进/后退快捷键：[commit 12](link)
     - **Home**：
       - a. 后退：若当前为第一页，执行重置（与现有行为一致）；否则回到前一页；
       - b. 前进：前往后一页（若存在）；
     - **BookDetail**：
       - a. 后退：关闭详情；
       - b. 前进：查看下一本（若存在）。
   - Electron ≥ 30 后的设置页对齐修复。
     - **Patch：** [commit 4](link)
    - 默认隐藏评论。
## 运行环境
* Windows 11
* 应用版本：1.6.10
