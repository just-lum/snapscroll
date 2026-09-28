# SnapScroll · 長截圖工坊

Chrome / Edge 的 Manifest V3 擴充功能，把整頁網頁擷取成一張長圖或一份 PDF。

純本機執行，零執行期依賴，無建置步驟。

---

## 功能

### 擷取模式

| 模式 | 說明 |
| --- | --- |
| 整頁 | 從頁面頂端捲動到底部，逐幀拼接成一張長圖 |
| 可視 | 只擷取目前視窗可見的區域，不捲動 |
| 框選 | 在頁面上拖曳出矩形範圍，可跨越多個視窗高度 |
| 元素 | 選取單一元素並擷取，包含高於視窗的元素 |
| 手動 | 由使用者自行捲動，擴充功能以固定間隔取樣拼接 |

### 輸出格式

- **PNG** — 無損。抓幀時同樣使用 PNG，不做二次壓縮。
- **JPEG / WebP** — 品質可調（30–100）。抓幀時即壓縮，記憶體用量較低。
- **PDF** — 紙張 A4 / A3 / Letter / Legal / Tabloid，直式或橫式，頁邊距 0–144pt。

PDF 分頁方式：

- 依紙寬縮放後分頁（預設）
- 單頁長圖（超過 PDF 單頁 14400pt 上限時自動改為分頁）
- 整張縮進一頁

### 選項

| 選項 | 說明 |
| --- | --- |
| 隱藏固定元素 | 擷取時隱藏 `position: fixed` / `sticky` 元素 |
| 隱藏捲軸 | 擷取時隱藏頁面捲軸 |
| 等待懶擷載入 | 頁面高度變動時延長等待 |
| 每屏等待 | 每幀之間的等待時間（0–1200ms） |
| 起始延遲 | 開始擷取前的延遲（0–60000ms） |
| 頁面高度上限 | 超過此高度的內容不擷取（1000–1000000px） |
| 抓幀格式 | 自動 / PNG / JPEG |
| 重試次數 | 單幀擷取失敗的重試上限 |
| 檔名模板 | 支援 `{date}` `{time}` `{datetime}` `{host}` `{title}` `{mode}` `{format}` `{width}` `{height}` `{index}` |
| 下載子資料夾 | 指定檔案存放的相對路徑 |
| 完成後開啟結果頁 | 擷取完成後開啟預覽頁 |
| 保留歷史筆數 | 本機歷史紀錄的上限 |

### 診斷

- **測試滾動** — 對目前頁面執行一次完整捲動（至底部再返回原位），回報可捲動性判定結果。
- **複製診斷** — 輸出目前頁面的量測資料與判定結果文字。
- **常駐顯示** — 捲動方式、頁面高度上限、內容高度（`document` / `body` / 視口）。

可捲動性判定分為五類：可捲動、有可捲動範圍但實際無法捲動、非原生捲動、頁面僅一屏、PDF 檢視器。

### 結果頁

- 預覽產出的圖片或 PDF
- 拖曳裁剪並另存為 PNG
- 轉存為 PNG / JPEG / WebP

### 歷史紀錄

- 存放於瀏覽器本機 IndexedDB
- 可設定保留筆數、可清空

### 其他

- **右鍵選單** — 整頁 / 可視區域 / 框選範圍 / 點選元素
- **鍵盤快捷鍵** — `Alt+Shift+S` 開啟面板，`Alt+Shift+F` 直接擷取整頁（可於 `chrome://extensions/shortcuts` 修改）
- **介面語言** — 簡體中文 / 繁體中文 / 英文（跟隨瀏覽器語言）

---

## 安裝

### 從 Release 安裝

1. 下載 `snapscroll-1.0.0.zip` 並解壓縮
2. 開啟 `chrome://extensions`（Edge 為 `edge://extensions`）
3. 開啟右上角「開發人員模式」
4. 點「載入未封裝項目」，選擇解壓縮後的資料夾

### 從原始碼安裝

```bash
git clone https://github.com/just-lum/snapscroll.git
cd snapscroll
node tools/make-icons.mjs
```

圖示由程式碼生成，需先執行一次。接著依上述步驟 2–4 載入該資料夾。

---

## 使用

1. 開啟任意網頁
2. 點擊工具列上的 SnapScroll 圖示
3. 選擇擷取模式與輸出格式
4. 點「開始擷取」

擷取期間頁面底部會顯示進度條（可於選項中關閉），工具列圖示同時顯示進度百分比。

---

## 權限

只申請 `activeTab`。擴充功能在使用者點擊圖示時，才取得當前分頁的臨時存取權；安裝時不取得任何網站的存取權。

| 權限 | 用途 |
| --- | --- |
| `activeTab` | 存取使用者當前操作的分頁 |
| `scripting` | 注入頁面代理腳本 |
| `downloads` | 儲存產出的檔案 |
| `storage` | 儲存設定 |
| `offscreen` | 影像拼接與編碼 |
| `contextMenus` | 右鍵選單 |

---

## 技術實現

### 架構

```
engine/      純函式模組（UMD）：捲動計劃、座標換算、PDF 分頁與生成、
             檔名處理、畫布上限、可捲動性判定
background/  Service worker（classic worker + importScripts）、擷取控制器、下載
injected/    注入頁面的代理：量測、捲動、進度條、框選與元素拾取
offscreen/   Offscreen document：畫布拼接、編碼、PDF 組裝
ui/          popup / options / result 三個頁面
```

同一份 `engine/` 模組同時被 Node 測試（`require`）、service worker（`importScripts`）與擴充頁面（`<script>`）載入，無建置步驟。

### 擷取流程

1. 注入頁面代理，量測視窗與文件尺寸
2. 探測頁面的捲動機制（實際捲動 1 像素後復位）
3. 預先捲動至底部再回到頂端（可選），使延遲載入內容就位
4. 逐幀捲動、擷取，送至 offscreen document 拼接
5. 編碼，並透過 downloads API 儲存

每一幀比對「要求捲動位置」與「實際捲動位置」；連續兩幀沒有位移時中止並回報錯誤。

### 捲動機制探測

頁面的捲動可能由不同元素驅動。擴充功能依序實測 `window`、頁面內可捲動容器、`body`，並於每次捲動後驗證位置是否如預期；若某種方式無效則切換下一種。捲動方式一經確定，讀取位置、計算範圍與下達指令皆依該方式執行。

### 畫布使用

拼接採用分段畫布：輸出按 y 軸切分為多條，逐幀繪入相交的分段，分段填滿後編碼並釋放。記憶體用量取決於單一分段的高度，而非整張圖的高度。

PDF 輸出時分段高度等於頁面高度，每頁僅進行一次 JPEG 編碼，並以 `/DCTDecode` 直接嵌入 PDF，無二次解碼。

### PDF 生成

`engine/pdf-writer.js` 產生 PDF 物件表與 xref 表。位元組偏移以實際寫入長度計算；非 ASCII 字串以 UTF-16BE 十六進位字串編碼。產出後執行結構自檢（檢查 xref 偏移是否指向對應物件）。

### 頁面狀態還原

擷取期間對頁面的變更皆記錄於還原清單，結束後（含失敗與取消）復原：固定元素的可見性、捲軸樣式、注入的樣式表、以及使用者原本的捲動位置。

---

## 已知限制

- **虛擬捲動清單** — 僅存在於 DOM 的可見項目可被擷取，此類清單無法取得完整內容。可使用「手動」模式。
- **跨網域 iframe** — 內容會出現在擷取結果中（畫面合成），但無法驅動其內部捲動。
- **擷取頻率限制** — `chrome.tabs.captureVisibleTab` 有呼叫頻率上限。「手動」模式的取樣間隔約 500ms。
- **畫布尺寸上限** — 超過上限時，PNG / JPEG / WebP 會輸出為多個檔案（`_part-01`、`_part-02`…）。PDF 不受影響。
- **受限頁面** — `chrome://`、擴充功能頁面與 `file://` 無法擷取。
- **PDF 檢視器** — 內容由瀏覽器外掛繪製，不在 DOM 中，無法捲動擷取。可改用「可視」模式。
- **非原生捲動** — 以 `transform` 或 canvas 驅動捲動的頁面，原生捲動 API 無法取得後續內容。
- **擷取期間請勿切換分頁** — `captureVisibleTab` 只能擷取視窗目前顯示的分頁。

---

## 開發

```bash
node --test                            # 單元測試（136 項）
node tools/make-icons.mjs              # 從程式碼生成圖示
node tools/package.mjs                 # 打包為 dist/snapscroll-<version>.zip
node tools/serve-fixtures.mjs --open   # 測試頁伺服器（http://127.0.0.1:8788）
node tools/e2e/run.mjs                 # 端對端測試（需 Playwright）
```

### 測試頁

`fixtures/` 包含各類測試頁面：

- `long-page.html` — 20000px 長頁面，每 100px 一條刻度、每 500px 一段編號
- `fixed-header.html` — 上／下／右各一個固定元素
- `lazy-images.html` — 捲動時才載入內容，頁面高度會變動
- `scroll-body.html` / `scroll-inner.html` / `scroll-js-container.html` / `scroll-hidden-overflow.html` — 捲動由 `body`、內層容器或 `overflow:hidden` 容器驅動
- `scroll-locked.html` — 捲動被腳本接管
- `scroll-transform.html` — 以 `transform` 驅動的非原生捲動
- `pdf-embed.html` — 模擬 PDF 檢視器

### 端對端測試

`tools/e2e/run.mjs` 啟動瀏覽器、載入擴充功能、執行實際擷取，並驗證產出檔案。測試時將擴充功能複製至暫存目錄，並在該副本的 manifest 加入 `<all_urls>` 權限（自動化環境沒有使用者手勢，`activeTab` 不會生效）。

Playwright 非必要依賴；未安裝時會顯示安裝指令。

---

## 授權

MIT
