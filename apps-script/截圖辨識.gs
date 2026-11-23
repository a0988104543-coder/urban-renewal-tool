/**
 * 都更速算工具｜截圖辨識（獨立 Apps Script，不綁試算表）
 *
 * 用途：前端傳一張截圖（base64），由 Gemini 判斷是哪一種截圖並讀出數字，回傳 JSON。
 * 只讀兩種截圖：
 *   parcel ＝ 地號查詢結果（土地分頁）：地段地號、面積、公告現值、公告地價
 *   stats  ＝ 自劃區統計表：土地登記總面積、建物登記總面積
 * 其他圖一律回傳 type = unknown，前端會略過。
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   GEMINI_API_KEY  必填
 *   GEMINI_MODEL    選填，可用逗號列多個模型，依序嘗試（前一個忙線或不可用就換下一個）
 *                   預設 gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash
 *
 * 部署：部署作業 → 新增部署作業 → 網頁應用程式
 *       執行身分：我　／　誰可以存取：所有人
 * 之後更新：管理部署作業 → 編輯 → 建立新版本（不要再新增部署作業，否則網址會變）
 */

var DEFAULT_MODEL = 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash';

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'models') return json_(listModels_());
  return json_({ ok: true, service: 'urban-renewal-ocr' });
}

/** 列出這把金鑰可用、支援 generateContent 的模型名稱（不含金鑰）。 */
function listModels_() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return { ok: false, error: res.getResponseCode() + ' ' + res.getContentText().slice(0, 200) };
  var ms = (JSON.parse(res.getContentText()).models || []).filter(function (m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
  }).map(function (m) { return m.name.replace('models/', ''); });
  return { ok: true, models: ms };
}

function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents || '{}');
    if (p.action !== 'recognize') return json_({ ok: false, error: '未知的 action：' + p.action });
    if (!p.base64Data) return json_({ ok: false, error: '沒有收到圖片' });
    var r = recognize_(p.base64Data, p.mimeType || 'image/jpeg');
    r.ok = true;
    return json_(r);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// 欄位與前端「複製提問」（index.html 的 OCR_PROMPT_CHAT）相同；改一邊要一起改
var PROMPT = [
  '你會看到一張台灣地政網站的截圖（例如臺北市「整合資訊查詢結果」土地分頁、新北市地號查詢「分析」頁、查詢範圍的土地建物統計表）。請先判斷類型，再只讀出指定欄位。',
  '',
  '類型 parcel：單一地號的土地資訊。',
  '  lot ＝ 地段地號，寫成「段名＋母號-子號」，例如「福和段一小段0546-0000」「中原段0506-0000」（看不清楚填 null）',
  '  city ＝ 縣市（臺北市／新北市）；截圖沒寫但從網站可確定時照填，否則 null',
  '  district ＝ 行政區，例如「中正區」「中和區」',
  '  area_m2 ＝ 面積或登記面積（平方公尺）',
  '  ann ＝ 公告現值（元／平方公尺）',
  '  lp ＝ 公告地價（元／平方公尺）',
  '  zone_now ＝ 目前使用分區全名，例如「第三種商業區」「乙種工業區」「住宅區」；國字大寫（壹貳參肆）改寫成一二三四',
  '  zone_orig ＝ 有寫「原屬○○」或「○○特（○○）」時，填原分區全名，例如「第三種住宅區」；沒有填 null',
  '  pub_pct ＝ 公有持分比例（0～100）。權屬只有私有、自然人、法人時填 0；有國有、市有、縣有、公有時填其百分比合計；看不出來填 null',
  '  own_text ＝ 權屬原文照抄，例如「私有(100%)」「法人公司96%自然人4%」',
  '類型 stats：查詢範圍的土地建物統計表。',
  '  land_count ＝ 土地登記筆數；land_total_m2 ＝ 土地登記總面積（平方公尺）',
  '  bldg_count ＝ 建物登記筆數；bldg_total_m2 ＝ 建物登記總面積（平方公尺）',
  '都不是：type 填 unknown。',
  '',
  '規則：',
  '- 數字照圖上抄，去掉千分位逗號與單位，不要換算、不要四捨五入、不要推估。',
  '- 圖上看不到或看不清楚的欄位填 null，絕對不要猜。',
  '- 不屬於該類型的欄位一律填 null。',
  '- 若單位不是平方公尺或元／平方公尺（例如坪、元／坪），該欄填 null。',
  '- 不要輸出所有權人姓名等個人資料。'
].join('\n');

var SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['parcel', 'stats', 'unknown'] },
    lot: { type: 'STRING', nullable: true },
    city: { type: 'STRING', nullable: true },
    district: { type: 'STRING', nullable: true },
    area_m2: { type: 'NUMBER', nullable: true },
    ann: { type: 'NUMBER', nullable: true },
    lp: { type: 'NUMBER', nullable: true },
    zone_now: { type: 'STRING', nullable: true },
    zone_orig: { type: 'STRING', nullable: true },
    pub_pct: { type: 'NUMBER', nullable: true },
    own_text: { type: 'STRING', nullable: true },
    land_count: { type: 'NUMBER', nullable: true },
    land_total_m2: { type: 'NUMBER', nullable: true },
    bldg_count: { type: 'NUMBER', nullable: true },
    bldg_total_m2: { type: 'NUMBER', nullable: true }
  },
  required: ['type']
};

function recognize_(b64, mime) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Apps Script 沒有設定 GEMINI_API_KEY');
  var models = (props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL).split(',')
    .map(function (m) { return m.trim(); }).filter(String);

  var body = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mime, data: b64 } },
      { text: PROMPT }
    ] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      maxOutputTokens: 1536   // 防止模型卡住一直重複輸出同一個字（欄位變多，略為放寬）
    }
  };
  var opt = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };

  // 依序嘗試每個模型；忙線（429/503/500）先等一下重試一次，還不行就換下一個模型；其他錯誤直接換下一個
  // 回傳的 JSON 壞掉（例如模型卡住一直輸出 0）也當成這個模型失敗，換下一個
  var r = null, model = null, errs = [];
  for (var i = 0; i < models.length && r === null; i++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent';
    for (var attempt = 0; attempt < 2; attempt++) {
      var res = UrlFetchApp.fetch(url, opt);
      var code = res.getResponseCode();
      if (code === 200) {
        r = parseOut_(res.getContentText());
        if (r) model = models[i]; else errs.push(models[i] + ' 輸出異常');
        break;
      }
      errs.push(models[i] + ' ' + code);
      if (code === 429 || code >= 500) { if (attempt === 0) { Utilities.sleep(2000); continue; } }
      break;
    }
  }
  if (r === null) throw new Error('辨識失敗（' + errs.join('、') + '），請按重試');

  // 只回傳約定的欄位，數字以外一律當 null（前端 ocrClean 會再整理一次）
  var keys = ['area_m2', 'ann', 'lp', 'land_total_m2', 'bldg_total_m2', 'land_count', 'bldg_count'];
  var clean = { type: ['parcel', 'stats'].indexOf(r.type) >= 0 ? r.type : 'unknown', model: model };
  keys.forEach(function (k) {
    var v = r[k];
    clean[k] = (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
  });
  var isP = clean.type === 'parcel';
  // 地號：只留文字、去掉空白、去掉「地號」；格式要像「○○段0000-0000」或「○○段00000000」，否則當讀不到
  var lot = (isP && typeof r.lot === 'string') ? r.lot.replace(/\s+/g, '').replace(/地號$/, '') : '';
  clean.lot = (lot.length <= 30 && /段/.test(lot) && /段?\d{1,8}(-\d{1,4})?$/.test(lot)) ? lot : null;
  // 文字欄位：限長度，避免模型卡住輸出一長串
  ['city', 'district', 'zone_now', 'zone_orig', 'own_text'].forEach(function (k) {
    var v = isP && typeof r[k] === 'string' ? r[k].trim() : '';
    clean[k] = v && v.length <= 60 && v.toLowerCase() !== 'null' ? v : null;
  });
  var pp = r.pub_pct;
  clean.pub_pct = (isP && typeof pp === 'number' && isFinite(pp) && pp >= 0 && pp <= 100) ? pp : null;
  return clean;
}

/** 從 Gemini 回應取出 JSON 物件；壞掉就回傳 null。 */
function parseOut_(text) {
  try {
    var data = JSON.parse(text);
    var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    var out = parts.filter(function (x) { return x.text && !x.thought; })
                   .map(function (x) { return x.text; }).join('');
    var s = out.indexOf('{'), t = out.lastIndexOf('}');
    if (s < 0 || t < s) return null;
    var r = JSON.parse(out.slice(s, t + 1));
    return (r && typeof r === 'object') ? r : null;
  } catch (e) { return null; }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** 在編輯器手動執行，確認金鑰與模型可用（看執行記錄）。 */
function testKey() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  var model = (props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL).split(',')[0].trim();
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model, {
    headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
}
