/**
 * 都更速算工具｜截圖辨識（獨立 Apps Script，不綁試算表）
 *
 * 用途：前端傳一張截圖（base64），由 Gemini 判斷是哪一種截圖並讀出數字，回傳 JSON。
 * 只讀兩種截圖：
 *   parcel ＝ 地號查詢結果（土地分頁）：面積、公告現值、公告地價
 *   stats  ＝ 自劃區統計表：土地登記總面積、建物登記總面積
 * 其他圖一律回傳 type = unknown，前端會略過。
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   GEMINI_API_KEY  必填
 *   GEMINI_MODEL    選填，預設 gemini-2.5-flash
 *
 * 部署：部署作業 → 新增部署作業 → 網頁應用程式
 *       執行身分：我　／　誰可以存取：所有人
 * 之後更新：管理部署作業 → 編輯 → 建立新版本（不要再新增部署作業，否則網址會變）
 */

var DEFAULT_MODEL = 'gemini-2.5-flash';

function doGet() {
  return json_({ ok: true, service: 'urban-renewal-ocr' });
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
  var model = props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL;

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
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  var opt = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };

  var res = UrlFetchApp.fetch(url, opt);
  if (res.getResponseCode() === 429 || res.getResponseCode() >= 500) { // 速率限制或暫時錯誤：等一下重試一次
    Utilities.sleep(2500);
    res = UrlFetchApp.fetch(url, opt);
  }
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error('Gemini 錯誤 ' + code + '：' + text.slice(0, 300));

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
  return clean;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** 在編輯器手動執行，確認金鑰與模型可用（看執行記錄）。 */
function testKey() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  var model = props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL;
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model, {
    headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
}
