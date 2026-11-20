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

var PROMPT = [
  '你會看到一張台灣地政或都市更新網站的截圖。請先判斷類型，再只讀出指定的數字。',
  '',
  '類型 parcel：單一地號的土地資訊（例如「整合資訊查詢結果」的土地分頁），有「面積」「公告現值」「公告地價」。',
  '  lot ＝ 地段地號，照圖上抄成一行文字，例如「福和段一小段0546-0000」（看不清楚填 null）',
  '  area_m2 ＝ 面積（平方公尺）',
  '  ann ＝ 公告現值（元／平方公尺）',
  '  lp ＝ 公告地價（元／平方公尺）',
  '類型 stats：查詢範圍的土地建物統計表，有「土地登記總面積」「建物登記總面積」。',
  '  land_total_m2 ＝ 土地登記總面積（平方公尺）',
  '  bldg_total_m2 ＝ 建物登記總面積（平方公尺）',
  '都不是：type 填 unknown。',
  '',
  '規則：',
  '- 數字照圖上抄，去掉千分位逗號與單位，不要換算、不要四捨五入、不要推估。',
  '- 圖上看不到或看不清楚的欄位填 null，絕對不要猜。',
  '- 不屬於該類型的欄位一律填 null。',
  '- 若單位不是平方公尺或元／平方公尺（例如坪、元／坪），該欄填 null。'
].join('\n');

var SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['parcel', 'stats', 'unknown'] },
    lot: { type: 'STRING', nullable: true },
    area_m2: { type: 'NUMBER', nullable: true },
    ann: { type: 'NUMBER', nullable: true },
    lp: { type: 'NUMBER', nullable: true },
    land_total_m2: { type: 'NUMBER', nullable: true },
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
      responseSchema: SCHEMA
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
  var text = null, model = null, errs = [];
  for (var i = 0; i < models.length && text === null; i++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent';
    for (var attempt = 0; attempt < 2; attempt++) {
      var res = UrlFetchApp.fetch(url, opt);
      var code = res.getResponseCode();
      if (code === 200) { text = res.getContentText(); model = models[i]; break; }
      errs.push(models[i] + ' ' + code);
      if (code === 429 || code >= 500) { if (attempt === 0) { Utilities.sleep(2000); continue; } }
      break;
    }
  }
  if (text === null) throw new Error('Gemini 暫時無法使用（' + errs.join('、') + '），請稍後再試');

  var data = JSON.parse(text);
  var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  var out = parts.filter(function (x) { return x.text && !x.thought; })
                 .map(function (x) { return x.text; }).join('');
  var s = out.indexOf('{'), t = out.lastIndexOf('}');
  if (s < 0 || t < s) throw new Error('Gemini 沒有回傳 JSON：' + out.slice(0, 200));
  var r = JSON.parse(out.slice(s, t + 1));

  // 只回傳約定的欄位，數字以外一律當 null
  var keys = ['area_m2', 'ann', 'lp', 'land_total_m2', 'bldg_total_m2'];
  var clean = { type: ['parcel', 'stats'].indexOf(r.type) >= 0 ? r.type : 'unknown', model: model };
  keys.forEach(function (k) {
    var v = r[k];
    clean[k] = (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
  });
  // 地號：只留文字、去掉空白；不是 parcel 一律 null
  var lot = (clean.type === 'parcel' && typeof r.lot === 'string') ? r.lot.replace(/\s+/g, '') : '';
  clean.lot = lot ? lot.slice(0, 40) : null;
  return clean;
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
