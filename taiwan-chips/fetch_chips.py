#!/usr/bin/env python3
"""台股每日籌碼觀察：抓取「每日數據」A:U 原始值並做自動檢查。

用法：
  python3 fetch_chips.py 2026-11-06 [--prev-o 9440465] [--out result.json]

輸出 JSON：
  status   ok | holiday | error
  row      A:U 21 個值（數字或空字串），可直接寫入「每日數據」
  fields   欄名 → 值（方便閱讀）
  errors   抓不到、未公布、檢查不通過的項目（任何一項 → status=error）
  checks   已通過的檢查
  prev_o_fix  官方修正後的上一列 O 值；無修正則為 null

只用 Python 標準庫，不需安裝套件。
"""
import argparse
import csv
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0"
TWSE = "https://www.twse.com.tw/rwd/zh"
TAIFEX = "https://www.taifex.com.tw/cht"

COLS = [
    "A 日期", "B 加權指數", "C 漲跌點", "D 成交金額（億元）",
    "E 外資現貨買賣超（億元）", "F 投信買賣超（億元）", "G 自營商避險買賣超（億元）",
    "H 外資 TX 淨未平倉", "I 外資 MTX 淨未平倉", "J 外資 TMF 淨未平倉", "K 投信 TX 淨未平倉",
    "L 台指近月收盤", "M 美元兌新台幣", "N 上市融資餘額（億元）", "O 上市融資餘額（張）",
    "P P/C 未平倉比", "Q 期交所 VIX",
    "R 大額前五大賣方", "S 大額前十大賣方", "T 大額前十大買方",
    "U 外資股票期貨淨額（億元）",
]

# 合理範圍：超出即視為抓錯
RANGES = {
    "B": (10_000, 100_000), "D": (1_000, 50_000),
    "E": (-10_000, 10_000), "F": (-10_000, 10_000), "G": (-10_000, 10_000),
    "H": (-300_000, 300_000), "I": (-300_000, 300_000), "J": (-300_000, 300_000),
    "K": (-300_000, 300_000), "L": (10_000, 100_000), "M": (25, 40),
    "N": (1_000, 20_000), "O": (1_000_000, 30_000_000), "P": (10, 300), "Q": (5, 150),
    "R": (0, 300_000), "S": (0, 300_000), "T": (0, 300_000), "U": (-10_000, 10_000),
}


class Fail(Exception):
    pass


_last_twse = [0.0]


def http(url, data=None):
    body = urllib.parse.urlencode(data).encode() if data else None
    is_twse = "twse.com.tw" in url
    last = None
    for i in range(4):
        if is_twse:  # 證交所限流：請求間隔至少 4 秒
            wait = 4 - (time.time() - _last_twse[0])
            if wait > 0:
                time.sleep(wait)
            _last_twse[0] = time.time()
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:
            last = e
            # 307 = 被限流，等久一點；其他錯誤（連線中斷）短暫重試
            throttled = getattr(e, "code", None) == 307
            time.sleep((15 if throttled else 3) * (i + 1))
    raise Fail(f"連線失敗：{url}（{last}）")


def num(s):
    s = str(s).strip().replace(",", "")
    if s in ("", "-", "--"):
        raise Fail(f"值為空：{s!r}")
    return float(s)


def twse_json(path, **q):
    j = json.loads(http(f"{TWSE}/{path}?" + urllib.parse.urlencode({**q, "response": "json"})))
    return j


class Tables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.r, self.c = [], None, None

    def handle_starttag(self, t, a):
        if t == "tr":
            self.r = []
        elif t in ("td", "th") and self.r is not None:
            self.c = ""

    def handle_endtag(self, t):
        if t in ("td", "th") and self.c is not None and self.r is not None:
            self.r.append(re.sub(r"\s+", " ", self.c).strip())
            self.c = None
        elif t == "tr" and self.r is not None:
            if any(self.r):
                self.rows.append(self.r)
            self.r = None

    def handle_data(self, d):
        if self.c is not None:
            self.c += d


def html_rows(raw):
    p = Tables()
    p.feed(raw.decode("utf-8", "replace"))
    return p.rows


def big5_csv(raw):
    return list(csv.reader(io.StringIO(raw.decode("big5", "replace"))))


def first_num(cell):
    """「92,195 (92,195)」→ 92195，取括號外的數字。"""
    return num(cell.split("(")[0])


# ---------- 各來源 ----------

def src_fmtqik(d, ymd, roc):
    j = twse_json("afterTrading/FMTQIK", date=ymd)
    if j.get("stat") != "OK":
        raise Fail(f"FMTQIK stat={j.get('stat')}")
    f = j["fields"]
    rows = j["data"]
    idx = {r[0].strip(): r for r in rows}
    if roc not in idx:
        return None  # 當日無資料 → 休市或未公布，由呼叫端判斷
    r = idx[roc]
    B = num(r[f.index("發行量加權股價指數")])
    C = num(r[f.index("漲跌點數")])
    D = round(num(r[f.index("成交金額")]) / 1e8, 2)
    checks = []
    # 檢查：今日指數 − 前一交易日指數 = 漲跌點
    pos = [x[0].strip() for x in rows].index(roc)
    if pos > 0:
        prev = num(rows[pos - 1][f.index("發行量加權股價指數")])
        if abs(B - prev - C) > 0.02:
            raise Fail(f"漲跌點不符：{B}−{prev}≠{C}")
        checks.append("漲跌點 = 今日指數 − 前日指數")
    return {"B": B, "C": C, "D": D}, checks


def src_bfi82u(ymd):
    j = twse_json("fund/BFI82U", type="day", dayDate=ymd)
    if j.get("stat") != "OK":
        raise Fail(f"BFI82U 未公布（stat={j.get('stat')}）")
    if j.get("date") != ymd:
        raise Fail(f"BFI82U 日期不符：{j.get('date')}")
    k = j["fields"].index("買賣差額")
    m = {r[0].strip(): num(r[k]) for r in j["data"]}
    need = ["外資及陸資(不含外資自營商)", "投信", "自營商(避險)", "合計"]
    for n in need:
        if n not in m:
            raise Fail(f"BFI82U 找不到列：{n}")
    parts = sum(v for n, v in m.items() if n != "合計")
    if abs(parts - m["合計"]) > 1:
        raise Fail("BFI82U 各項加總 ≠ 合計")
    return ({"E": round(m[need[0]] / 1e8, 1), "F": round(m["投信"] / 1e8, 1),
             "G": round(m["自營商(避險)"] / 1e8, 1)},
            ["三大法人各項加總 = 合計"])


def src_margin(ymd, prev_o):
    j = twse_json("marginTrading/MI_MARGN", date=ymd, selectType="MS")
    if j.get("stat") != "OK" or not j.get("tables"):
        raise Fail(f"MI_MARGN 未公布（stat={j.get('stat')}）")
    t = j["tables"][0]
    f = t["fields"]
    rows = {r[0].strip(): r for r in t["data"]}
    sh = rows.get("融資(交易單位)")
    amt = rows.get("融資金額(仟元)")
    if not sh or not amt:
        raise Fail("MI_MARGN 找不到融資列")
    today, prev = f.index("今日餘額"), f.index("前日餘額")
    O = int(num(sh[today]))
    N = round(num(amt[today]) / 1e5, 1)
    checks = []
    fix = {}
    if prev_o is not None:
        # 證交所隔日會小幅修正前日餘額（實測 −2、+10 張），萬分之一以內視為官方修正
        official = int(num(sh[prev]))
        gap = official - int(prev_o)
        if abs(gap) > prev_o * 0.0001:
            raise Fail(f"融資前日餘額 {official:,} 與試算表上一列 {prev_o:,} 差 {gap:+,} 張，超過萬分之一")
        if gap:
            checks.append(f"融資前日餘額官方修正 {gap:+} 張 → 上一列 O 應改為 {official}")
            fix = {"_prev_o_fix": official}
        else:
            checks.append("融資前日餘額 = 試算表上一列")
    return {"N": N, "O": O, **fix}, checks


def src_inst_fut(slash):
    rows = big5_csv(http(f"{TAIFEX}/3/futContractsDateDown",
                         {"queryStartDate": slash, "queryEndDate": slash, "commodityId": ""}))
    h = rows[0]
    k = h.index("多空未平倉口數淨額")
    kv = h.index("多空未平倉契約金額淨額(千元)")
    m = {}
    for r in rows[1:]:
        if len(r) > kv and r[0].strip() == slash:
            m[(r[1].strip(), r[2].strip())] = r
    def g(name, who, col=k):
        r = m.get((name, who))
        if r is None:
            raise Fail(f"期貨法人找不到：{name}/{who}（可能未公布）")
        return num(r[col])
    return ({"H": int(g("臺股期貨", "外資及陸資")), "I": int(g("小型臺指期貨", "外資及陸資")),
             "J": int(g("微型臺指期貨", "外資及陸資")), "K": int(g("臺股期貨", "投信")),
             "U": round(g("股票期貨", "外資及陸資", kv) / 1e5, 1)}, [])


def src_fut_close(slash):
    rows = big5_csv(http(f"{TAIFEX}/3/futDataDown",
                         {"down_type": "1", "commodity_id": "TX", "commodity_id2": "",
                          "queryStartDate": slash, "queryEndDate": slash}))
    h = [x.strip() for x in rows[0]]
    ci, mi, close, vol, sess = (h.index("交易日期"), h.index("到期月份(週別)"),
                                h.index("收盤價"), h.index("成交量"), h.index("交易時段"))
    cand = [r for r in rows[1:] if len(r) > sess and r[ci].strip() == slash
            and r[sess].strip() == "一般" and "/" not in r[mi]]
    if not cand:
        raise Fail("台指期行情未公布")
    best = max(cand, key=lambda r: num(r[vol]))  # 近月 = 成交量最大
    return {"L": num(best[close])}, [f"近月契約 {best[mi].strip()}（成交量最大）"]


def src_fx(slash):
    rows = html_rows(http(f"{TAIFEX}/3/dailyFXRate",
                          {"queryStartDate": slash, "queryEndDate": slash}))
    hdr = next((r for r in rows if "美元／新台幣" in r), None)
    if not hdr:
        raise Fail("匯率表頭找不到「美元／新台幣」")
    k = hdr.index("美元／新台幣")
    r = next((r for r in rows if r and r[0] == slash), None)
    if not r:
        raise Fail("匯率未公布")
    return {"M": num(r[k])}, []


def src_pc(slash):
    rows = big5_csv(http(f"{TAIFEX}/3/pcRatioDown",
                         {"queryStartDate": slash, "queryEndDate": slash}))
    h = [x.strip() for x in rows[0]]
    k = h.index("買賣權未平倉量比率%")
    r = next((r for r in rows[1:] if r and r[0].strip() == slash), None)
    if not r:
        raise Fail("P/C 未公布")
    return {"P": num(r[k])}, []


def src_vix(ymd):
    txt = http(f"{TAIFEX}/7/getVixData?filesname={ymd}").decode("big5", "replace")
    line = next((l for l in txt.splitlines() if l.startswith(ymd) and "Last 1 min AVG" in l), None)
    if not line:
        raise Fail("VIX 收盤值未公布")
    return {"Q": num(line.split()[-1])}, []


def src_large(slash):
    rows = html_rows(http(f"{TAIFEX}/3/largeTraderFutQry", {"queryDate": slash, "contractId": "TX"}))
    r = next((r for r in rows if r and r[0] == "所有契約"), None)
    if not r or len(r) < 10:
        raise Fail("大額交易人找不到「所有契約」列")
    T, R, S, oi = first_num(r[3]), first_num(r[5]), first_num(r[7]), first_num(r[9])
    if not (R <= S <= oi and T <= oi):
        raise Fail("大額交易人數值關係不合理")
    return {"R": int(R), "S": int(S), "T": int(T)}, ["大額：前五 ≤ 前十 ≤ 全市場未平倉"]


# ---------- 主流程 ----------

def run(date, prev_o=None):
    ymd = date.replace("-", "")
    slash = date.replace("-", "/")
    y, mth, dd = date.split("-")
    roc = f"{int(y) - 1911}/{mth}/{dd}"

    out = {"date": date, "status": "ok", "row": [], "fields": {}, "errors": [], "checks": [],
           "prev_o_fix": None}
    vals = {"A": date}

    try:
        fm = src_fmtqik(date, ymd, roc)
    except Fail as e:
        out.update(status="error", errors=[f"FMTQIK：{e}"])
        return out
    if fm is None:
        # 加權指數無當日資料：再用三大法人確認是休市而非未公布
        try:
            src_bfi82u(ymd)
            out.update(status="error", errors=["加權指數未公布，但三大法人已有資料"])
        except Fail:
            out["status"] = "holiday"
        return out
    vals.update(fm[0]); out["checks"] += fm[1]

    jobs = [("BFI82U", lambda: src_bfi82u(ymd)),
            ("融資", lambda: src_margin(ymd, prev_o)),
            ("期貨法人", lambda: src_inst_fut(slash)),
            ("台指期收盤", lambda: src_fut_close(slash)),
            ("匯率", lambda: src_fx(slash)),
            ("P/C", lambda: src_pc(slash)),
            ("VIX", lambda: src_vix(ymd)),
            ("大額交易人", lambda: src_large(slash))]
    for name, fn in jobs:
        try:
            v, c = fn()
            vals.update(v); out["checks"] += c
        except Fail as e:
            out["errors"].append(f"{name}：{e}")
        except Exception as e:  # 格式變了等非預期錯誤
            out["errors"].append(f"{name}：非預期錯誤 {type(e).__name__}: {e}")

    for k, (lo, hi) in RANGES.items():
        if k in vals and not (lo <= vals[k] <= hi):
            out["errors"].append(f"{k} 超出合理範圍：{vals[k]}")
    if "B" in vals and "L" in vals and abs(vals["L"] - vals["B"]) > vals["B"] * 0.05:
        out["errors"].append(f"期現價差過大：{vals['L']} vs {vals['B']}")

    out["prev_o_fix"] = vals.pop("_prev_o_fix", None)
    letters = [c.split()[0] for c in COLS]
    out["row"] = [vals.get(k, "") for k in letters]
    out["fields"] = {c: vals.get(c.split()[0], "") for c in COLS}
    missing = [c for c in COLS if c.split()[0] not in vals]
    if missing:
        out["errors"].append("缺欄：" + "、".join(missing))
    if out["errors"]:
        out["status"] = "error"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("date", help="YYYY-MM-DD")
    ap.add_argument("--prev-o", type=int, help="試算表上一列的 O 欄（融資張數），用來核對前日餘額")
    ap.add_argument("--out")
    a = ap.parse_args()
    res = run(a.date, a.prev_o)
    s = json.dumps(res, ensure_ascii=False, indent=1)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(s)
    print(s)
    sys.exit(0 if res["status"] in ("ok", "holiday") else 1)


if __name__ == "__main__":
    main()
