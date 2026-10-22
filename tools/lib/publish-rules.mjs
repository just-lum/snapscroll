/* SnapScroll — 發佈包規則
 *
 * 打包（package.mjs）與驗證（verify-dist.mjs）共用同一份名單。
 * 兩支腳本各寫一份的話，改了一邊忘另一邊，門禁就形同虛設。
 */

/* 發佈包裡不該出現的路徑。黑名單本身會漏（新增目錄時沒人記得補），
 * 所以 verify-dist.mjs 會拿它複驗 zip 實體，而不是只信打包腳本。 */
export const FORBIDDEN = [
  /^tools\//,
  /^tests\//,
  /^fixtures\//,
  /^\.github\//,
  /^\.vscode\//,
  /(^|\/)\.git/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^package\.json$/,
  /(^|\/)node_modules\//,
  /* 執行產物：腳本輸出日誌、打包工作區、e2e 臨時檔。
   * 這些被 .gitignore 擋在版本庫外，但打包是走檔案系統遍歷，
   * 所以必須在這裡再擋一次——_out_e2e-full.txt 就進過發佈包。 */
  /^_out_/,
  /^dist\//,
  /^\.tmp\//
];

/** 回傳混進發佈包的開發檔案名單（空陣列＝乾淨）。 */
export function devFileLeaks(names) {
  return names.filter(name => FORBIDDEN.some(re => re.test(name)));
}

/** manifest 直接指到的檔案，全部得存在，否則擴充功能載不進來。 */
export function manifestRefs(manifest) {
  const refs = new Set();
  const add = value => {
    if (typeof value === 'string' && value.length > 0) refs.add(value);
  };

  for (const file of Object.values(manifest.icons ?? {})) add(file);
  for (const file of Object.values(manifest.action?.default_icon ?? {})) add(file);
  add(manifest.action?.default_popup);
  add(manifest.options_ui?.page);
  add(manifest.options_page);
  add(manifest.background?.service_worker);
  add(manifest.background?.page);
  add(manifest.side_panel?.default_path);
  add(manifest.devtools_page);

  for (const entry of manifest.content_scripts ?? []) {
    for (const file of entry.js ?? []) add(file);
    for (const file of entry.css ?? []) add(file);
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const file of entry.resources ?? []) add(file);
  }

  /* default_locale 目錄不存在時，所有 __MSG_ 都會解析失敗。 */
  if (manifest.default_locale) {
    refs.add(`_locales/${manifest.default_locale}/messages.json`);
  }

  return [...refs].filter(ref => !ref.includes('*'));
}

/** 抽出 service worker 裡 importScripts 的每個目標。 */
export function importScriptsOf(source) {
  const refs = [];
  const callRe = /importScripts\s*\(([\s\S]*?)\)\s*;/g;
  let call;
  while ((call = callRe.exec(source)) !== null) {
    const argRe = /['"]([^'"]+)['"]/g;
    let arg;
    while ((arg = argRe.exec(call[1])) !== null) refs.push(arg[1]);
  }
  return refs;
}

/** 抽出 HTML 裡的 src / href 相對引用，外鏈與 data: 一律跳過。 */
export function htmlRefsOf(source) {
  const refs = [];
  const attrRe = /\b(?:src|href)\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = attrRe.exec(source)) !== null) {
    const value = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) continue;
    refs.push(value.split('?')[0].split('#')[0]);
  }
  return refs;
}
