"""
Stock Analyzer — Flask 서버
DART 전자공시 API로 기업정보 및 재무제표 실데이터 조회
DART 미지원 항목(주가·PER 등)은 더미 데이터 폴백
"""
import os, random, threading, zipfile, io, re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup
from flask import Flask, render_template, jsonify, request
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)
app.json.sort_keys = False   # 딕셔너리 삽입 순서 유지 (한글 알파벳 정렬 방지)

@app.after_request
def no_cache(resp):
    """개발 환경: 정적 파일 캐시 방지"""
    if request.path.startswith('/static/'):
        resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
        resp.headers['Pragma'] = 'no-cache'
    return resp

DART_KEY  = os.getenv('DART_API_KEY', '').strip()
DART_BASE = 'https://opendart.fss.or.kr/api'

# ── 주가 히스토리 (더미) ────────────────────────────────────
def gen_prices(base_price, seed, days=90):
    random.seed(seed)
    price = base_price * 0.82
    prices, dates = [], []
    base_date = datetime.now() - timedelta(days=days)
    for i in range(days):
        price *= (1 + random.gauss(0.0008, 0.016))
        price = max(price, base_price * 0.5)
        prices.append(round(price))
        dates.append((base_date + timedelta(days=i)).strftime('%m/%d'))
    prices[-1] = base_price
    return dates, prices

# ── 더미 기업 데이터 (주가·시총 등 DART 미제공 항목) ─────────
COMPANIES = {
    "005930": {"name": "삼성전자", "code": "005930", "sector": "반도체/전자",
               "market": "KOSPI", "current_price": 75400, "prev_price": 74200,
               "market_cap": 4502000, "shares": 5969782550,
               "w52_high": 88800, "w52_low": 55000,
               "description": "세계 최대 메모리 반도체 및 스마트폰 제조업체"},
    "000660": {"name": "SK하이닉스", "code": "000660", "sector": "반도체",
               "market": "KOSPI", "current_price": 198500, "prev_price": 195000,
               "market_cap": 1443000, "shares": 728002365,
               "w52_high": 238000, "w52_low": 123500,
               "description": "DRAM, NAND Flash 등 메모리 반도체 전문 기업"},
    "035420": {"name": "NAVER", "code": "035420", "sector": "인터넷/IT서비스",
               "market": "KOSPI", "current_price": 178000, "prev_price": 175500,
               "market_cap": 292000, "shares": 164263395,
               "w52_high": 215000, "w52_low": 148000,
               "description": "국내 최대 인터넷 검색 포털 및 IT 플랫폼 기업"},
    "035720": {"name": "카카오", "code": "035720", "sector": "인터넷/IT서비스",
               "market": "KOSPI", "current_price": 42850, "prev_price": 43200,
               "market_cap": 190000, "shares": 444068500,
               "w52_high": 56500, "w52_low": 33450,
               "description": "모바일 메신저 카카오톡 기반 IT 플랫폼 기업"},
    "066570": {"name": "LG전자", "code": "066570", "sector": "전기전자",
               "market": "KOSPI", "current_price": 96500, "prev_price": 95000,
               "market_cap": 157000, "shares": 163647814,
               "w52_high": 112000, "w52_low": 75200,
               "description": "가전·TV·B2B 솔루션 글로벌 전자 기업"},
}

# ── 더미 재무 데이터 (DART 연결 실패 시 폴백) ──────────────
FINANCIALS = {
    "005930": {
        "income_statement": {
            "years": ["2021", "2022", "2023", "2024"],
            "revenue":          [2796048, 3023512, 2589355, 3002440],
            "operating_profit": [516339,  433766,  65670,   322480],
            "net_income":       [399074,  355438,  154871,  289831],
            "operating_margin": [18.5,    14.3,    2.5,     10.7],
        },
        "balance_sheet": {
            "year": "2024",
            "operating_assets":     {"매출채권": 312450, "재고자산": 283940, "유형자산": 1125680,
                                     "무형자산": 145230, "기타영업자산": 89340, "합계": 1956640},
            "non_operating_assets": {"현금및현금성자산": 963450, "단기금융자산": 812340,
                                     "장기금융자산": 234560, "관계기업투자": 189670,
                                     "기타비영업자산": 67890, "합계": 2267910},
            "non_op_income": {"이자수익": 14820, "배당금수입": 3240, "지분법이익": 9480, "합계": 27540},
            "total_assets": 4224550, "total_liabilities": 1198340, "total_equity": 3026210,
        },
        "cash_flow": {
            "years": ["2021", "2022", "2023", "2024"],
            "operating_cf": [652478,  621137,  432984,  521340],
            "investing_cf":  [-452341, -518902, -389012, -412340],
            "financing_cf":  [-125340, -178901, -145230, -134560],
        },
        "ratios": {"per": 15.2, "pbr": 1.45, "roe": 12.3, "eps": 4962,
                   "bps": 52034, "debt_ratio": 39.6, "dividend_yield": 2.8},
    },
}

for _code, _scale in [("000660", 0.48), ("035420", 0.18), ("035720", 0.12), ("066570", 0.35)]:
    random.seed(hash(_code) % 999)
    _b = FINANCIALS["005930"]
    FINANCIALS[_code] = {
        "income_statement": {
            "years": _b["income_statement"]["years"],
            "revenue":          [round(v * _scale) for v in _b["income_statement"]["revenue"]],
            "operating_profit": [round(v * _scale * random.uniform(0.7, 1.1))
                                 for v in _b["income_statement"]["operating_profit"]],
            "net_income":       [round(v * _scale * random.uniform(0.6, 1.0))
                                 for v in _b["income_statement"]["net_income"]],
            "operating_margin": [round(v * random.uniform(0.6, 1.3), 1)
                                 for v in _b["income_statement"]["operating_margin"]],
        },
        "balance_sheet": {
            "year": "2024",
            "operating_assets":     {k: round(v * _scale) for k, v in _b["balance_sheet"]["operating_assets"].items()},
            "non_operating_assets": {k: round(v * _scale) for k, v in _b["balance_sheet"]["non_operating_assets"].items()},
            "non_op_income":        {k: round(v * _scale * random.uniform(0.7, 1.3))
                                     for k, v in _b["balance_sheet"]["non_op_income"].items()},
            "total_assets":      round(_b["balance_sheet"]["total_assets"] * _scale),
            "total_liabilities": round(_b["balance_sheet"]["total_liabilities"] * _scale),
            "total_equity":      round(_b["balance_sheet"]["total_equity"] * _scale),
        },
        "cash_flow": {
            "years": _b["cash_flow"]["years"],
            "operating_cf": [round(v * _scale) for v in _b["cash_flow"]["operating_cf"]],
            "investing_cf":  [round(v * _scale) for v in _b["cash_flow"]["investing_cf"]],
            "financing_cf":  [round(v * _scale) for v in _b["cash_flow"]["financing_cf"]],
        },
        "ratios": {
            "per": round(_b["ratios"]["per"] * random.uniform(0.7, 2.2), 1),
            "pbr": round(_b["ratios"]["pbr"] * random.uniform(0.6, 2.5), 2),
            "roe": round(_b["ratios"]["roe"] * random.uniform(0.5, 1.6), 1),
            "eps": round(_b["ratios"]["eps"] * _scale),
            "bps": round(_b["ratios"]["bps"] * _scale),
            "debt_ratio": round(_b["ratios"]["debt_ratio"] * random.uniform(0.5, 1.5), 1),
            "dividend_yield": round(_b["ratios"]["dividend_yield"] * random.uniform(0.3, 1.6), 1),
        },
    }

COMPETITORS = {
    "005930": [{"code": "000660", "name": "SK하이닉스"}, {"code": "066570", "name": "LG전자"}],
    "000660": [{"code": "005930", "name": "삼성전자"}],
    "035420": [{"code": "035720", "name": "카카오"}],
    "035720": [{"code": "035420", "name": "NAVER"}],
    "066570": [{"code": "005930", "name": "삼성전자"}],
}

# ── 수출국·고객사 큐레이팅 데이터 (IR·사업보고서 기반) ──────────
EXPORT_DATA = {
    "005930": {
        "export_ratio": 91,
        "regions": [
            {"name": "아메리카",     "ratio": 30, "flag": "🌎"},
            {"name": "중화권",       "ratio": 22, "flag": "🇨🇳"},
            {"name": "아시아/아프리카","ratio":22, "flag": "🌏"},
            {"name": "유럽",         "ratio": 17, "flag": "🌍"},
            {"name": "한국",         "ratio": 9,  "flag": "🇰🇷"},
        ],
        "customers": [
            {"name": "NVIDIA",    "segment": "HBM 메모리",      "flag": "🇺🇸", "note": "HBM3E 독점 공급"},
            {"name": "Apple",     "segment": "DRAM · 파운드리", "flag": "🇺🇸", "note": "iPhone DRAM 공급"},
            {"name": "Amazon",    "segment": "서버 DRAM",        "flag": "🇺🇸", "note": "AWS 데이터센터"},
            {"name": "Google",    "segment": "HBM · DDR5",      "flag": "🇺🇸", "note": "AI 인프라 공급"},
            {"name": "Microsoft", "segment": "서버 DRAM",        "flag": "🇺🇸", "note": "Azure 데이터센터"},
        ],
        "key_countries": ["🇺🇸 미국", "🇨🇳 중국", "🇻🇳 베트남", "🇮🇳 인도", "🇩🇪 독일", "🇧🇷 브라질"],
        "production_base": ["🇰🇷 수원·화성·평택", "🇻🇳 하노이·타이응우옌", "🇨🇳 시안·쑤저우·후이저우", "🇮🇳 노이다"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    "000660": {
        "export_ratio": 97,
        "regions": [
            {"name": "아시아",   "ratio": 72, "flag": "🌏"},
            {"name": "아메리카", "ratio": 23, "flag": "🌎"},
            {"name": "유럽",     "ratio": 5,  "flag": "🌍"},
        ],
        "customers": [
            {"name": "NVIDIA",  "segment": "HBM3E",         "flag": "🇺🇸", "note": "AI GPU향 HBM 1위"},
            {"name": "Apple",   "segment": "LPDDR5X",       "flag": "🇺🇸", "note": "iPhone 모바일 DRAM"},
            {"name": "Amazon",  "segment": "DDR5 서버",      "flag": "🇺🇸", "note": "AWS 서버용"},
            {"name": "Google",  "segment": "HBM · 서버 DRAM","flag": "🇺🇸", "note": "TPU·AI 인프라"},
            {"name": "Meta",    "segment": "서버 DRAM",      "flag": "🇺🇸", "note": "AI 데이터센터"},
        ],
        "key_countries": ["🇺🇸 미국", "🇨🇳 중국", "🇯🇵 일본", "🇹🇼 대만", "🇩🇪 독일"],
        "production_base": ["🇰🇷 이천·청주", "🇨🇳 우시·충칭"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    "035420": {
        "export_ratio": 35,
        "regions": [
            {"name": "한국",     "ratio": 65, "flag": "🇰🇷"},
            {"name": "일본",     "ratio": 20, "flag": "🇯🇵"},
            {"name": "동남아",   "ratio": 10, "flag": "🌏"},
            {"name": "기타",     "ratio": 5,  "flag": "🌐"},
        ],
        "customers": [
            {"name": "라인야후",    "segment": "플랫폼 · 광고",  "flag": "🇯🇵", "note": "일본 메신저 1위"},
            {"name": "NAVER 웹툰", "segment": "글로벌 웹툰",    "flag": "🌐",  "note": "북미·유럽 서비스"},
            {"name": "네이버플러스", "segment": "멤버십",        "flag": "🇰🇷", "note": "국내 구독 서비스"},
            {"name": "스마트스토어", "segment": "커머스 광고",   "flag": "🇰🇷", "note": "국내 SME 파트너"},
        ],
        "key_countries": ["🇯🇵 일본", "🇺🇸 미국", "🇹🇭 태국", "🇹🇼 대만", "🇫🇷 프랑스"],
        "production_base": ["🇰🇷 성남 분당 (본사)", "🇯🇵 도쿄", "🇫🇷 파리 (기술연구소)"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    "035720": {
        "export_ratio": 18,
        "regions": [
            {"name": "한국",     "ratio": 82, "flag": "🇰🇷"},
            {"name": "일본",     "ratio": 10, "flag": "🇯🇵"},
            {"name": "기타",     "ratio": 8,  "flag": "🌐"},
        ],
        "customers": [
            {"name": "카카오픽코마", "segment": "웹툰·웹소설",   "flag": "🇯🇵", "note": "일본 웹툰 1위"},
            {"name": "카카오게임즈", "segment": "모바일 게임",   "flag": "🌐",  "note": "글로벌 게임 퍼블리싱"},
            {"name": "카카오페이",  "segment": "핀테크",        "flag": "🇰🇷", "note": "국내 간편결제"},
            {"name": "광고주 SME", "segment": "카카오톡 광고",  "flag": "🇰🇷", "note": "국내 광고 파트너"},
        ],
        "key_countries": ["🇯🇵 일본", "🇺🇸 미국", "🇸🇬 싱가포르"],
        "production_base": ["🇰🇷 판교 (본사)", "🇯🇵 도쿄"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    "066570": {
        "export_ratio": 85,
        "regions": [
            {"name": "아메리카", "ratio": 35, "flag": "🌎"},
            {"name": "아시아",   "ratio": 25, "flag": "🌏"},
            {"name": "유럽",     "ratio": 22, "flag": "🌍"},
            {"name": "한국",     "ratio": 15, "flag": "🇰🇷"},
            {"name": "중동/아프리카","ratio": 3,"flag": "🌍"},
        ],
        "customers": [
            {"name": "GM · 현대차", "segment": "전장(VS)",         "flag": "🌐",  "note": "전기차 전장 부품"},
            {"name": "아마존",      "segment": "가전 유통",        "flag": "🇺🇸", "note": "북미 가전 1위 채널"},
            {"name": "베스트바이",  "segment": "가전 유통",        "flag": "🇺🇸", "note": "미국 오프라인 유통"},
            {"name": "기업 B2B",    "segment": "HVAC · 빌딩솔루션","flag": "🌐",  "note": "글로벌 냉난방 B2B"},
        ],
        "key_countries": ["🇺🇸 미국", "🇩🇪 독일", "🇮🇳 인도", "🇧🇷 브라질", "🇦🇺 호주", "🇲🇽 멕시코"],
        "production_base": ["🇰🇷 창원·구미", "🇲🇽 멕시코시티", "🇵🇱 폴란드 므와바", "🇮🇳 푸네", "🇺🇸 테네시"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── 현대차 ──────────────────────────────────────────────────
    "005380": {
        "export_ratio": 77,
        "regions": [
            {"name": "아메리카", "ratio": 34, "flag": "🌎"},
            {"name": "아시아/기타","ratio": 31,"flag": "🌏"},
            {"name": "유럽",     "ratio": 16, "flag": "🌍"},
            {"name": "한국",     "ratio": 19, "flag": "🇰🇷"},
        ],
        "customers": [
            {"name": "딜러 네트워크 (미국)", "segment": "완성차 판매", "flag": "🇺🇸", "note": "4,000+ 딜러"},
            {"name": "딜러 네트워크 (유럽)", "segment": "완성차 판매", "flag": "🌍",  "note": "독일·영국·프랑스"},
            {"name": "기업 B2B · 렌터카",   "segment": "단체 판매",  "flag": "🇰🇷", "note": "국내 기업·렌탈"},
            {"name": "현대캐피탈",           "segment": "금융 서비스","flag": "🌐",  "note": "글로벌 할부·리스"},
        ],
        "key_countries": ["🇺🇸 미국", "🇮🇳 인도", "🇩🇪 독일", "🇨🇿 체코", "🇧🇷 브라질", "🇮🇩 인도네시아"],
        "production_base": ["🇰🇷 울산·아산·전주", "🇺🇸 조지아(HMGMA)", "🇮🇳 체나이", "🇨🇿 노쇼비체", "🇮🇩 카라왕"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── 기아 ────────────────────────────────────────────────────
    "000270": {
        "export_ratio": 73,
        "regions": [
            {"name": "아메리카", "ratio": 37, "flag": "🌎"},
            {"name": "한국",     "ratio": 27, "flag": "🇰🇷"},
            {"name": "유럽",     "ratio": 20, "flag": "🌍"},
            {"name": "아시아/기타","ratio": 16,"flag": "🌏"},
        ],
        "customers": [
            {"name": "딜러 네트워크 (미국)", "segment": "완성차 판매", "flag": "🇺🇸", "note": "2,000+ 딜러"},
            {"name": "딜러 네트워크 (유럽)", "segment": "완성차 판매", "flag": "🌍",  "note": "Sportage·EV6"},
            {"name": "기아 인디아",          "segment": "현지 생산",  "flag": "🇮🇳", "note": "Seltos·Sonet"},
        ],
        "key_countries": ["🇺🇸 미국", "🇩🇪 독일", "🇸🇰 슬로바키아", "🇮🇳 인도", "🇦🇺 호주"],
        "production_base": ["🇰🇷 광명·화성·광주", "🇺🇸 조지아(KGA)", "🇸🇰 질리나", "🇮🇳 아난타푸르"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── 두산에너빌리티 ──────────────────────────────────────────
    "034020": {
        "export_ratio": 60,
        "regions": [
            {"name": "한국",   "ratio": 40, "flag": "🇰🇷"},
            {"name": "중동",   "ratio": 25, "flag": "🌍"},
            {"name": "동남아", "ratio": 20, "flag": "🌏"},
            {"name": "유럽",   "ratio": 10, "flag": "🌍"},
            {"name": "기타",   "ratio": 5,  "flag": "🌐"},
        ],
        "customers": [
            {"name": "한국전력(KEPCO)", "segment": "원전·가스발전",  "flag": "🇰🇷", "note": "국내 발전소 핵심 납품처"},
            {"name": "Saudi Aramco",    "segment": "발전·담수 플랜트","flag": "🇸🇦", "note": "중동 에너지 인프라"},
            {"name": "UAE EWEC",        "segment": "가스복합발전",    "flag": "🇦🇪", "note": "아부다비 발전 프로젝트"},
            {"name": "Westinghouse",    "segment": "원전 기자재",     "flag": "🇺🇸", "note": "APR1400 협력"},
        ],
        "key_countries": ["🇰🇷 한국", "🇸🇦 사우디", "🇦🇪 UAE", "🇵🇱 폴란드", "🇨🇿 체코", "🇺🇸 미국"],
        "production_base": ["🇰🇷 창원(본사·공장)", "🇺🇸 피콘스(HRSG)", "🇨🇿 두산 Škoda Power"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── LG화학 ──────────────────────────────────────────────────
    "051910": {
        "export_ratio": 65,
        "regions": [
            {"name": "한국",     "ratio": 35, "flag": "🇰🇷"},
            {"name": "아메리카", "ratio": 25, "flag": "🌎"},
            {"name": "중화권",   "ratio": 20, "flag": "🇨🇳"},
            {"name": "유럽",     "ratio": 18, "flag": "🌍"},
            {"name": "기타",     "ratio": 2,  "flag": "🌐"},
        ],
        "customers": [
            {"name": "Tesla",        "segment": "배터리 소재(양극재)","flag": "🇺🇸", "note": "NMC 양극재 공급"},
            {"name": "GM",           "segment": "배터리 소재",        "flag": "🇺🇸", "note": "Ultium Cells 파트너"},
            {"name": "Volkswagen",   "segment": "배터리 소재",        "flag": "🇩🇪", "note": "유럽 EV향 소재"},
            {"name": "현대차·기아",  "segment": "석유화학·소재",      "flag": "🇰🇷", "note": "ABS·엔지니어링 소재"},
        ],
        "key_countries": ["🇺🇸 미국", "🇨🇳 중국", "🇩🇪 독일", "🇵🇱 폴란드", "🇰🇷 한국"],
        "production_base": ["🇰🇷 오창·여수·울산", "🇺🇸 오하이오(GM JV)", "🇵🇱 브로츠와프", "🇨🇳 난징·우시"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── 셀트리온 ────────────────────────────────────────────────
    "068270": {
        "export_ratio": 90,
        "regions": [
            {"name": "유럽",     "ratio": 50, "flag": "🌍"},
            {"name": "아메리카", "ratio": 25, "flag": "🌎"},
            {"name": "아시아",   "ratio": 15, "flag": "🌏"},
            {"name": "한국",     "ratio": 10, "flag": "🇰🇷"},
        ],
        "customers": [
            {"name": "Pfizer (Inflectra)",  "segment": "램시마 미국 유통",   "flag": "🇺🇸", "note": "미국 TNF 시밀러 파트너"},
            {"name": "NHS (영국 국민보건)", "segment": "Inflectra",           "flag": "🇬🇧", "note": "인플릭시맙 최대 구매처"},
            {"name": "Stada",               "segment": "유럽 바이오시밀러",   "flag": "🇩🇪", "note": "유럽 유통 파트너"},
            {"name": "국내 병원·약국",      "segment": "유플라이마·렉키로나", "flag": "🇰🇷", "note": "국내 바이오의약품"},
        ],
        "key_countries": ["🇬🇧 영국", "🇩🇪 독일", "🇫🇷 프랑스", "🇺🇸 미국", "🇨🇦 캐나다", "🇯🇵 일본"],
        "production_base": ["🇰🇷 인천 송도(본사·1공장)", "🇨🇷 코스타리카(2공장)"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── 삼성SDI ─────────────────────────────────────────────────
    "006400": {
        "export_ratio": 92,
        "regions": [
            {"name": "유럽",     "ratio": 42, "flag": "🌍"},
            {"name": "아시아",   "ratio": 28, "flag": "🌏"},
            {"name": "아메리카", "ratio": 20, "flag": "🌎"},
            {"name": "한국",     "ratio": 8,  "flag": "🇰🇷"},
            {"name": "기타",     "ratio": 2,  "flag": "🌐"},
        ],
        "customers": [
            {"name": "BMW",        "segment": "전기차 배터리",   "flag": "🇩🇪", "note": "iX·5시리즈 EV 배터리"},
            {"name": "Volkswagen", "segment": "전기차 배터리",   "flag": "🇩🇪", "note": "MEB 플랫폼 공급"},
            {"name": "Rivian",     "segment": "원통형 배터리",   "flag": "🇺🇸", "note": "21700·46파이 공급"},
            {"name": "Stellantis", "segment": "원통형·파우치",   "flag": "🌍",  "note": "유럽 EV 배터리"},
            {"name": "삼성전자",   "segment": "스마트폰 배터리", "flag": "🇰🇷", "note": "Galaxy 소형 배터리"},
        ],
        "key_countries": ["🇩🇪 독일", "🇭🇺 헝가리", "🇺🇸 미국", "🇨🇳 중국", "🇲🇾 말레이시아"],
        "production_base": ["🇰🇷 기흥·천안·울산", "🇭🇺 괴드·이반차", "🇨🇳 시안·톈진", "🇲🇾 말레이시아"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── 한화에어로스페이스 ──────────────────────────────────────
    "012450": {
        "export_ratio": 52,
        "regions": [
            {"name": "한국",   "ratio": 48, "flag": "🇰🇷"},
            {"name": "유럽",   "ratio": 22, "flag": "🌍"},
            {"name": "중동",   "ratio": 14, "flag": "🌍"},
            {"name": "아시아", "ratio": 10, "flag": "🌏"},
            {"name": "기타",   "ratio": 6,  "flag": "🌐"},
        ],
        "customers": [
            {"name": "폴란드 국방부",   "segment": "K9·K239 무기체계", "flag": "🇵🇱", "note": "K9 672문 수출"},
            {"name": "UAE 국방부",      "segment": "K9 자주포",         "flag": "🇦🇪", "note": "중동 최대 방산 계약"},
            {"name": "한국 방위사업청", "segment": "K21·레드백",        "flag": "🇰🇷", "note": "국내 육군 핵심 장비"},
            {"name": "사우디 SANG",     "segment": "방위 체계 수출",    "flag": "🇸🇦", "note": "방어 시스템"},
        ],
        "key_countries": ["🇵🇱 폴란드", "🇦🇺 호주", "🇦🇪 UAE", "🇸🇦 사우디", "🇳🇴 노르웨이", "🇮🇳 인도"],
        "production_base": ["🇰🇷 창원·구미", "🇺🇸 텍사스(엔진)", "🇦🇺 한화디펜스 호주"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── POSCO홀딩스 ─────────────────────────────────────────────
    "005490": {
        "export_ratio": 42,
        "regions": [
            {"name": "한국",   "ratio": 58, "flag": "🇰🇷"},
            {"name": "아시아", "ratio": 28, "flag": "🌏"},
            {"name": "아메리카","ratio": 8,  "flag": "🌎"},
            {"name": "유럽",   "ratio": 6,  "flag": "🌍"},
        ],
        "customers": [
            {"name": "현대차·기아",  "segment": "자동차용 강판",    "flag": "🇰🇷", "note": "국내 완성차 1위 납품처"},
            {"name": "현대중공업",   "segment": "선박용 후판",      "flag": "🇰🇷", "note": "조선 3사 주요 공급"},
            {"name": "삼성전자·LG",  "segment": "전자용 스테인리스","flag": "🇰🇷", "note": "가전·디스플레이 소재"},
            {"name": "Toyota·Honda", "segment": "수출 자동차강판",  "flag": "🇯🇵", "note": "일본 완성차 수출"},
        ],
        "key_countries": ["🇰🇷 한국", "🇨🇳 중국", "🇮🇳 인도", "🇯🇵 일본", "🇦🇷 아르헨티나"],
        "production_base": ["🇰🇷 포항·광양(본사)", "🇮🇳 마하라슈트라(포스코인디아)", "🇦🇷 마르델플라타"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
    # ── 현대모비스 ──────────────────────────────────────────────
    "012330": {
        "export_ratio": 87,
        "regions": [
            {"name": "아메리카",  "ratio": 32, "flag": "🌎"},
            {"name": "유럽",      "ratio": 25, "flag": "🌍"},
            {"name": "아시아/기타","ratio": 30, "flag": "🌏"},
            {"name": "한국",      "ratio": 13, "flag": "🇰🇷"},
        ],
        "customers": [
            {"name": "현대차그룹",  "segment": "모듈·핵심부품",  "flag": "🇰🇷", "note": "현대차·기아·제네시스 전용"},
            {"name": "GM",          "segment": "EV 부품·ADAS",   "flag": "🇺🇸", "note": "GM 전기차 전동화 협력"},
            {"name": "Volkswagen",  "segment": "램프·ADAS",      "flag": "🇩🇪", "note": "유럽 OEM 공급 확대"},
        ],
        "key_countries": ["🇺🇸 미국", "🇩🇪 독일", "🇨🇳 중국", "🇮🇳 인도", "🇨🇿 체코", "🇸🇰 슬로바키아"],
        "production_base": ["🇰🇷 울산·아산·화성·광주", "🇺🇸 앨라배마·조지아", "🇩🇪 뤼셀스하임", "🇨🇳 베이징·칭다오"],
        "source": "2024년 사업보고서 · IR 자료 기반",
    },
}

AI_REPORTS = {
    "005930": {
        "rating": "매수", "target_price": 90000, "current_price": 75400, "upside": 19.4,
        "summary": "삼성전자는 HBM3E 등 고부가가치 메모리 포트폴리오 강화와 파운드리 경쟁력 제고를 통해 2025년 실적 개선이 기대됩니다. AI 서버향 메모리 수요 급증이 핵심 성장 동력입니다.",
        "strengths": ["HBM3E 양산 및 엔비디아 공급망 진입으로 AI 메모리 직접 수혜",
                      "세계 1위 DRAM 점유율(약 40%)로 가격 결정력 보유",
                      "순현금 약 80조원 — 안정적인 주주환원 여력",
                      "파운드리 2나노 공정 로드맵 가시화"],
        "risks": ["파운드리 TSMC 대비 기술 격차 지속",
                  "중국 메모리 업체 저가 공세 심화",
                  "스마트폰 교체 사이클 지연",
                  "원/달러 환율 변동성"],
        "catalysts": ["HBM4 양산 성공 및 차세대 GPU 탑재",
                      "파운드리 고객사 다각화 성과",
                      "주주환원 프로그램 확대"],
        "analyst": "AI 분석 엔진 v2.1", "date": "2025-05-12",
    },
}
for _code in COMPANIES:
    if _code in AI_REPORTS: continue
    random.seed(hash(_code) % 100)
    _c = COMPANIES[_code]
    _tp = round(_c["current_price"] * random.uniform(1.10, 1.30) / 500) * 500
    AI_REPORTS[_code] = {
        "rating": random.choice(["매수", "매수", "중립"]),
        "target_price": _tp, "current_price": _c["current_price"],
        "upside": round((_tp - _c["current_price"]) / _c["current_price"] * 100, 1),
        "summary": f"{_c['name']}은(는) {_c['sector']} 섹터 내 견고한 시장 지위를 바탕으로 안정적인 실적 성장이 기대됩니다.",
        "strengths": ["안정적 수익 구조와 강한 현금 창출력", "시장 지배적 포지션과 브랜드 파워"],
        "risks": ["경쟁 심화로 인한 마진 압박", "환율·원자재 변동 리스크"],
        "catalysts": ["신제품 출시", "해외 시장 확대", "주주환원 정책 강화"],
        "analyst": "AI 분석 엔진 v2.1", "date": "2025-05-12",
    }

# ── 실시간 시세 (Naver Finance 1차, Yahoo Finance 2차) ─────────
_price_cache   = {}   # code → {"data": {...}, "ts": datetime}
_history_cache = {}   # code → {"data": {...}, "ts": datetime}
_shares_cache  = {}   # code → {"shares": int, "ts": datetime}
_peers_cache   = {}   # code → {"data": [...], "ts": datetime}
_emp_cache     = {}   # code → {"count": int, "ts": datetime}
_exec_cache    = {}   # code → {"data": {...}, "ts": datetime}
_PRICE_TTL     = 60        # 초
_HISTORY_TTL   = 300       # 5분
_SHARES_TTL    = 3600 * 6  # 6시간
_PEERS_TTL     = 3600      # 1시간
_EMP_TTL       = 3600 * 6  # 6시간
_EXEC_TTL      = 3600 * 6  # 6시간


def _parse_kr_price(text):
    """'279,000' → 279000"""
    try:
        return int(str(text).replace(",", "").replace(" ", "").split(".")[0])
    except:
        return 0


def _parse_kr_cap(text):
    """'1,631조 1,117억' → 억원 정수"""
    text = str(text).replace(",", "")
    jo  = re.search(r"(\d+)조", text)
    eok = re.search(r"(\d+)억", text)
    result = 0
    if jo:  result += int(jo.group(1)) * 10000
    if eok: result += int(eok.group(1))
    return result


def _parse_naver_ratio(text, strip_suffix):
    """'42.50배' → 42.50,  '6,564원' → 6564,  '0.60%' → 0.60"""
    try:
        return float(str(text).replace(",", "").replace(strip_suffix, "").strip())
    except:
        return None


def _fetch_naver_price(code):
    """Naver Finance에서 현재가·전일가·52주·시총·시장·PER·PBR·EPS·BPS·배당 조회."""
    try:
        hdr = {"User-Agent": "Mozilla/5.0"}
        b   = requests.get(f"https://m.stock.naver.com/api/stock/{code}/basic",
                           headers=hdr, timeout=8).json()
        cur = _parse_kr_price(b.get("closePrice", 0))
        if not cur:
            return None
        market = b.get("stockExchangeName", "KOSPI")

        # 등락 — Naver basic API에서 직접 제공 (시장 마감 시에도 정확)
        try:
            chg_amt = int(str(b.get("compareToPreviousClosePrice", "0")).replace(",", ""))
        except:
            chg_amt = 0
        try:
            chg_pct = float(str(b.get("fluctuationsRatio", "0.00")).replace(",", ""))
        except:
            chg_pct = 0.0
        direction = (b.get("compareToPreviousPrice") or {}).get("code", "EVEN")
        if direction == "FALL":
            chg_amt = -abs(chg_amt)
            chg_pct = -abs(chg_pct)
        elif direction == "RISE":
            chg_amt = abs(chg_amt)
            chg_pct = abs(chg_pct)

        g     = requests.get(f"https://m.stock.naver.com/api/stock/{code}/integration",
                             headers=hdr, timeout=8).json()
        infos = {item["key"]: item["value"]
                 for item in g.get("totalInfos", []) if "key" in item}

        prev = _parse_kr_price(infos.get("전일", cur))
        hi52 = _parse_kr_price(infos.get("52주 최고", 0))
        lo52 = _parse_kr_price(infos.get("52주 최저", 0))
        mcap = _parse_kr_cap(infos.get("시총", ""))

        per  = _parse_naver_ratio(infos.get("PER",       ""), "배")
        pbr  = _parse_naver_ratio(infos.get("PBR",       ""), "배")
        eps  = _parse_naver_ratio(infos.get("EPS",       ""), "원")
        bps  = _parse_naver_ratio(infos.get("BPS",       ""), "원")
        div  = _parse_naver_ratio(infos.get("배당수익률", ""), "%")

        # 애널리스트 컨센서스 목표주가·투자의견
        ci              = g.get("consensusInfo") or {}
        consensus_tgt   = _parse_kr_price(ci.get("priceTargetMean", ""))  or None
        recomm_raw      = ci.get("recommMean", "")
        try:
            recomm_mean = float(str(recomm_raw).replace(",", "")) if recomm_raw else None
        except:
            recomm_mean = None

        return {"current_price": cur, "prev_price": prev,
                "change": chg_amt, "change_pct": chg_pct,
                "w52_high": hi52, "w52_low": lo52,
                "market_cap": mcap, "market": market,
                "per": per, "pbr": pbr,
                "eps": int(eps) if eps is not None else None,
                "bps": int(bps) if bps is not None else None,
                "dividend_yield": div,
                "consensus_target": consensus_tgt,
                "recomm_mean":      recomm_mean}
    except Exception as e:
        app.logger.warning(f"Naver Finance 실패 ({code}): {e}")
        return None


def _fetch_yahoo_price(code):
    """Yahoo Finance에서 현재가 조회 (Naver 실패 시 폴백)."""
    for suffix in (".KS", ".KQ"):
        try:
            url  = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}{suffix}"
            meta = requests.get(url, params={"range": "5d", "interval": "1d"},
                                headers={"User-Agent": "Mozilla/5.0"},
                                timeout=8).json() \
                           .get("chart", {}).get("result", [{}])[0].get("meta", {})
            cur = meta.get("regularMarketPrice")
            if not cur:
                continue
            # 실제 전일 종가는 closes[-2] (마지막은 오늘)에서 계산
            closes = (meta.get("closes") or [])
            prev   = closes[-2] if len(closes) >= 2 else cur
            return {"current_price": round(cur),
                    "prev_price":    round(prev),
                    "w52_high":      round(meta.get("fiftyTwoWeekHigh") or 0),
                    "w52_low":       round(meta.get("fiftyTwoWeekLow")  or 0),
                    "market_cap":    0,
                    "market":        "KOSPI" if suffix == ".KS" else "KOSDAQ"}
        except Exception as e:
            app.logger.warning(f"Yahoo Finance 실패 ({code}{suffix}): {e}")
    return None


def _fetch_naver_html_price(code):
    """Naver Finance HTML에서 주가·시총 스크래핑. 모바일 API 실패 시 폴백."""
    try:
        url  = f"https://finance.naver.com/item/main.naver?code={code}"
        r    = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=8)
        soup = BeautifulSoup(r.text, "html.parser")

        # 현재가
        price_el = soup.select_one("p.no_today em")
        if not price_el:
            return None
        for bl in price_el.select(".blind"):
            bl.decompose()
        cur = _parse_kr_price(price_el.get_text(strip=True))
        if not cur:
            return None

        # 시장 구분
        market = "KOSDAQ" if "코스닥" in r.text[:8000] else "KOSPI"

        # 시가총액 — em#_market_sum: "1,631조 1,117억" 또는 "1,631조\n\t1,117"
        mcap = 0
        mcap_el = soup.select_one("em#_market_sum")
        if mcap_el:
            raw = " ".join(mcap_el.get_text().split())  # 공백·탭 정리
            # 조 뒤 숫자에 억이 없으면 추가 ("1,631조 1,117" → "1,631조 1,117억")
            if "조" in raw and "억" not in raw:
                raw = re.sub(r'조\s+(\d[\d,]*)$', r'조 \1억', raw)
            mcap = _parse_kr_cap(raw)

        # 전일 종가 — table.no_info 첫 td에서 숫자만 추출
        prev = cur
        no_info = soup.select_one("table.no_info td")
        if no_info:
            nums = re.findall(r'[\d,]+', no_info.get_text())
            for n in nums:
                v = _parse_kr_price(n)
                if v > 1000:
                    prev = v
                    break

        return {"current_price": cur,  "prev_price":  prev,
                "w52_high":      0,    "w52_low":     0,
                "market_cap":    mcap, "market":      market,
                "per": None, "pbr": None, "eps": None, "bps": None,
                "dividend_yield": None, "consensus_target": None, "recomm_mean": None}
    except Exception as e:
        app.logger.warning(f"Naver HTML 파싱 실패 ({code}): {e}")
        return None


def _fetch_realtime_price(code):
    """Naver모바일→NaverHTML→Yahoo 순으로 실시간 주가 조회. 60초 캐시."""
    now    = datetime.now()
    cached = _price_cache.get(code)
    if cached and (now - cached["ts"]).total_seconds() < _PRICE_TTL:
        return cached["data"]
    data = _fetch_naver_price(code) or _fetch_naver_html_price(code) or _fetch_yahoo_price(code)
    if data:
        _price_cache[code] = {"data": data, "ts": now}
    return data


_COMMON_STOCK_SE = {"보통주", "의결권 있는 주식", "보통주식"}  # DART se 필드 다양


def _fetch_dart_shares(code):
    """DART 주식발행현황 API에서 보통주 발행주식 총수 조회. 6시간 캐시."""
    now    = datetime.now()
    cached = _shares_cache.get(code)
    if cached and (now - cached["ts"]).total_seconds() < _SHARES_TTL:
        return cached["shares"]
    if not DART_KEY:
        return None
    _corps_ready.wait(5)
    entry = _corp_by_code.get(code)
    if not entry:
        return None
    corp_code = entry["corp_code"]
    cur_year  = datetime.now().year

    # 전년 사업보고서 우선 (가장 안정적), 없으면 당해 분기보고서
    for year, reprt in [(cur_year-1, "11011"),   # 전년 사업보고서
                        (cur_year-2, "11011"),   # 전전년 사업보고서
                        (cur_year,   "11013"),   # 당해 1분기
                        (cur_year,   "11012")]:  # 당해 반기
        data = _dart_get("stockTotqySttus.json", {
            "corp_code":  corp_code,
            "bsns_year":  str(year),
            "reprt_code": reprt,
        })
        if not data:
            continue
        items = data.get("list", [])
        # 보통주 또는 의결권 있는 주식
        for item in items:
            se = (item.get("se") or "").strip()
            if se in _COMMON_STOCK_SE:
                try:
                    shares = int(item["istc_totqy"].replace(",", ""))
                    if shares > 0:
                        _shares_cache[code] = {"shares": shares, "ts": now}
                        return shares
                except:
                    pass
        # 합계 행으로 폴백 (보통주 행이 없는 경우)
        for item in items:
            se = (item.get("se") or "").strip()
            if se in ("합계", "계"):
                try:
                    shares = int(item["istc_totqy"].replace(",", ""))
                    if shares > 0:
                        _shares_cache[code] = {"shares": shares, "ts": now}
                        return shares
                except:
                    pass
    return None


def _parse_emp_year(items):
    """DART empSttus 목록 → 연도별 요약 딕셔너리 (인원수·급여).

    삼성전자처럼 남·여 행만 있고 합계 행이 없는 경우도 처리.
    """
    def _i(s):
        try: return max(0, int(str(s or "0").replace(",", "")))
        except: return 0
    def _f(s):
        try:
            v = float(str(s or "0").replace(",", ""))
            return v if v > 0 else None
        except: return None

    male = female = total = regular = contract = 0
    m_reg = m_con = f_reg = f_con = 0
    avg_sal = None

    # "성별합계" fo_bbm이 있으면 그것만 사용, 없으면 모든 행 집계 (SK하이닉스 등)
    has_summary = any(str(it.get("fo_bbm") or "").strip() == "성별합계" for it in items)
    target_fo   = "성별합계" if has_summary else None

    for item in items:
        fo  = str(item.get("fo_bbm",  "") or "").strip()
        sex = str(item.get("sexdstn", "") or "").strip()
        if target_fo and fo != target_fo:
            continue
        sm  = _i(item.get("sm"))
        r   = _i(item.get("rgllbr_co"))
        c   = _i(item.get("cnttk_co"))
        sal = _f(item.get("avg_sal"))

        if sex in ("남", "남성"):
            male  += sm; m_reg += r; m_con += c
        elif sex in ("여", "여성"):
            female += sm; f_reg += r; f_con += c
        else:                               # 합계 행 (있는 경우)
            total    = sm
            regular  = r
            contract = c
            if sal: avg_sal = sal

    # 합계 행이 없으면 남+여로 계산
    if total == 0:
        total = male + female
    if regular == 0:
        regular = m_reg + f_reg
    if contract == 0:
        contract = m_con + f_con
    if regular == 0 and total > 0:
        regular = total          # 계약직 데이터 없으면 전원 정규직으로 처리

    return {"total": total, "male": male, "female": female,
            "regular": regular, "contract": contract, "avg_salary": avg_sal}


def _fetch_dart_employees(code):
    """DART 직원현황에서 정규직 전체 직원수 조회. 6시간 캐시."""
    now    = datetime.now()
    cached = _emp_cache.get(code)
    if cached and (now - cached["ts"]).total_seconds() < _EMP_TTL:
        return cached["count"]
    if not DART_KEY:
        return None
    _corps_ready.wait(5)
    entry = _corp_by_code.get(code)
    if not entry:
        return None
    corp_code = entry["corp_code"]
    cur_year  = datetime.now().year
    for year, reprt in [(cur_year - 1, "11011"), (cur_year - 2, "11011")]:
        data = _dart_get("empSttus.json", {
            "corp_code": corp_code, "bsns_year": str(year), "reprt_code": reprt,
        })
        if not data or not data.get("list"):
            continue
        total = 0
        for item in data["list"]:
            if item.get("fo_bbm") == "성별합계":
                try:
                    total += int(str(item.get("sm", "0")).replace(",", ""))
                except:
                    pass
        if total > 0:
            _emp_cache[code] = {"count": total, "ts": now}
            return total
        # 폴백: 합계 행
        for item in data["list"]:
            if item.get("fo_bbm") in ("합계", "계"):
                try:
                    v = int(str(item.get("sm", "0")).replace(",", ""))
                    if v > 0:
                        _emp_cache[code] = {"count": v, "ts": now}
                        return v
                except:
                    pass
    return None


def _fetch_price_history(code, period="3mo"):
    """Yahoo Finance에서 일봉 종가 조회. 5분 캐시."""
    now        = datetime.now()
    cache_key  = f"{code}_{period}"
    cached     = _history_cache.get(cache_key)
    if cached and (now - cached["ts"]).total_seconds() < _HISTORY_TTL:
        return cached["data"]

    # 기간에 따라 interval 조정
    interval = "1wk" if period == "1y" else "1d"

    for suffix in (".KS", ".KQ"):
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}{suffix}"
            r   = requests.get(url, params={"range": period, "interval": interval},
                               headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
            j   = r.json()
            res = j.get("chart", {}).get("result", [])
            if not res:
                continue
            meta       = res[0].get("meta", {})
            timestamps = res[0].get("timestamp", [])
            closes     = res[0]["indicators"]["quote"][0].get("close", [])
            if not timestamps or not closes:
                continue

            fmt = "%y/%m/%d" if period == "1y" else "%m/%d"
            dates, prices = [], []
            for ts, c in zip(timestamps, closes):
                if c is None:
                    continue
                dates.append(datetime.fromtimestamp(ts).strftime(fmt))
                prices.append(round(c))

            # 당일 현재가가 마지막 항목과 다르면 추가
            cur = meta.get("regularMarketPrice")
            if cur and prices and round(cur) != prices[-1]:
                dates.append(now.strftime("%m/%d"))
                prices.append(round(cur))

            if not dates:
                continue

            data = {"dates": dates, "prices": prices, "_source": "realtime"}
            _history_cache[cache_key] = {"data": data, "ts": now}
            return data
        except Exception as e:
            app.logger.warning(f"가격 히스토리 실패 ({code}{suffix}): {e}")
    return None


def _fetch_naver_industry_peers(code):
    """Naver industryCompareInfo에서 동종업종 기업 목록 조회. 1시간 캐시."""
    now    = datetime.now()
    cached = _peers_cache.get(code)
    if cached and (now - cached["ts"]).total_seconds() < _PEERS_TTL:
        return cached["data"]
    try:
        hdr = {"User-Agent": "Mozilla/5.0"}
        g   = requests.get(f"https://m.stock.naver.com/api/stock/{code}/integration",
                           headers=hdr, timeout=8).json()
        peers = []
        for item in g.get("industryCompareInfo", []):
            peer_code = item.get("itemCode", "")
            if peer_code and peer_code != code:
                mv_raw = str(item.get("marketValue", "0")).replace(",", "")
                try:
                    mcap = round(int(mv_raw) / 100)  # 만원 단위 → 억원
                except:
                    mcap = 0
                peers.append({
                    "code":          peer_code,
                    "name":          item.get("stockName", ""),
                    "market_cap":    mcap,
                    "current_price": _parse_kr_price(item.get("closePrice", 0)),
                })
        _peers_cache[code] = {"data": peers, "ts": now}
        return peers
    except Exception as e:
        app.logger.warning(f"Naver 동종업종 조회 실패 ({code}): {e}")
        return []


# ── DART API ────────────────────────────────────────────────
_corp_by_code = {}    # stock_code  → {corp_code, name, stock_code}
_corp_by_name = {}    # corp_name   → entry
_corp_list    = []    # listed companies (stock_code 있는 것만)
_corps_ready  = threading.Event()
_api_cache    = {}    # endpoint+params key → response dict

CORP_CLS_MAP = {"Y": "KOSPI", "K": "KOSDAQ", "N": "KONEX", "E": "기타"}

def _bg_load_corps():
    if not DART_KEY:
        app.logger.warning("DART_API_KEY 미설정 — 더미 데이터로 동작")
        _corps_ready.set()
        return
    try:
        app.logger.info("DART 기업코드 목록 다운로드 중...")
        r = requests.get(f"{DART_BASE}/corpCode.xml",
                         params={"crtfc_key": DART_KEY}, timeout=60)
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            xml_data = zf.read("CORPCODE.xml").decode("utf-8")
        root = ET.fromstring(xml_data)
        for node in root.findall(".//list"):
            cc = (node.findtext("corp_code") or "").strip()
            nm = (node.findtext("corp_name") or "").strip()
            sc = (node.findtext("stock_code") or "").strip()
            if not cc: continue
            entry = {"corp_code": cc, "name": nm, "stock_code": sc}
            if nm: _corp_by_name[nm] = entry
            if sc:
                _corp_by_code[sc] = entry
                _corp_list.append(entry)
        app.logger.info(f"DART 기업코드 로드 완료: {len(_corp_list)}개 상장사")
    except Exception as e:
        app.logger.error(f"DART 기업코드 로드 실패: {e}")
    finally:
        _corps_ready.set()

threading.Thread(target=_bg_load_corps, daemon=True).start()


def _dart_get(endpoint, params, cache_ttl=True):
    if not DART_KEY:
        return None
    key = endpoint + str(sorted(params.items()))
    if cache_ttl and key in _api_cache:
        return _api_cache[key]
    try:
        p = {**params, "crtfc_key": DART_KEY}
        r = requests.get(f"{DART_BASE}/{endpoint}", params=p, timeout=15)
        data = r.json()
        if data.get("status") == "000":
            if cache_ttl:
                _api_cache[key] = data
            return data
        app.logger.warning(f"DART {endpoint} 오류: {data.get('status')} {data.get('message')}")
    except Exception as e:
        app.logger.error(f"DART 요청 실패 ({endpoint}): {e}")
    return None


def _to_ok(val):
    """DART 금액 문자열 → 억원 정수"""
    try:
        return int(str(val).replace(",", "").strip()) // 100_000_000
    except:
        return 0


def _find_acct(idx, sj, names):
    """DART 계정 인덱스에서 첫 번째 매칭 계정 반환.
    sj에 튜플/리스트 전달 시 순서대로 탐색 (IS 없는 기업은 CIS 사용).
    """
    sj_list = sj if isinstance(sj, (list, tuple)) else [sj]
    # 정확 매칭
    for s in sj_list:
        for nm in names:
            if (s, nm) in idx:
                return idx[(s, nm)]
    # 부분 매칭
    for s in sj_list:
        for nm in names:
            for (ss, n), v in idx.items():
                if ss == s and nm in n:
                    return v
    return None


def dart_company_info(corp_code):
    return _dart_get("company.json", {"corp_code": corp_code})


def dart_financials_raw(corp_code, year, fs_div):
    return _dart_get("fnlttSinglAcntAll.json", {
        "corp_code": corp_code, "bsns_year": str(year),
        "reprt_code": "11011", "fs_div": fs_div,
    })


def parse_dart_fin(items):
    """DART 재무항목 리스트 → 우리 응답 포맷 (억원 단위)"""
    idx = {}
    for it in items:
        sj  = it.get("sj_div", "")
        nm  = (it.get("account_nm") or "").strip()
        # 동일 계정이 여러 행인 경우 ord 낮은 것(상위)만 유지
        key = (sj, nm)
        if key not in idx or int(it.get("ord", 9999)) < int(idx[key].get("ord", 9999)):
            idx[key] = it

    def amounts(it):
        if not it:
            return 0, 0, 0
        return (_to_ok(it.get("thstrm_amount", 0)),
                _to_ok(it.get("frmtrm_amount", 0)),
                _to_ok(it.get("bfefrmtrm_amount", 0)))

    # bsns_year 필드를 직접 사용 (thstrm_nm은 "제 57 기" 형식이라 연도 추출 불가)
    bsns_y = int((items[0] if items else {}).get("bsns_year", str(datetime.now().year - 1)))
    years  = [str(bsns_y - 2), str(bsns_y - 1), str(bsns_y)]

    # 손익계산서 — IS 없는 기업(SK하이닉스 등)은 CIS(포괄손익계산서) 사용
    IS_SECTS = ("IS", "CIS")
    rev_it = _find_acct(idx, IS_SECTS, ["수익(매출액)", "매출액", "영업수익", "매출"])
    op_it  = _find_acct(idx, IS_SECTS, ["영업이익", "영업이익(손실)"])
    ni_it  = _find_acct(idx, IS_SECTS, ["당기순이익", "당기순이익(손실)",
                                         "지배기업의 소유주에게 귀속되는 당기순이익"])
    rev = amounts(rev_it)
    op  = amounts(op_it)
    ni  = amounts(ni_it)

    def pct(a, b):
        return round(a / b * 100, 1) if b else 0.0

    # 재무상태표 — 합계 (당기·전기 모두 추출)
    _l_it      = _find_acct(idx, "BS", ["부채총계"])
    _eq_it     = _find_acct(idx, "BS", ["자본총계", "자본합계"])
    total_a    = _to_ok((_find_acct(idx, "BS", ["자산총계"]) or {}).get("thstrm_amount", 0))
    total_l    = _to_ok((_l_it  or {}).get("thstrm_amount", 0))
    total_l_p  = _to_ok((_l_it  or {}).get("frmtrm_amount", 0))
    total_eq   = _to_ok((_eq_it or {}).get("thstrm_amount", 0))
    total_eq_p = _to_ok((_eq_it or {}).get("frmtrm_amount", 0))

    def bs_t(names):
        return _to_ok((_find_acct(idx, "BS", names) or {}).get("thstrm_amount", 0))

    # 매출원가
    cogs_it = _find_acct(idx, IS_SECTS, ["매출원가", "매출액의 원가"])
    cogs_cur = abs(_to_ok((cogs_it or {}).get("thstrm_amount", 0)))

    # 영업자산 항목
    ar    = bs_t(["매출채권 및 기타채권", "매출채권"])
    inv   = bs_t(["재고자산"])
    ppe   = bs_t(["유형자산"])
    intan = bs_t(["무형자산"])

    # 비영업자산 항목
    cash  = bs_t(["현금및현금성자산", "현금 및 현금성자산"])
    st_fi = bs_t(["단기금융상품", "기타유동금융자산", "단기투자자산"])
    lt_fi = bs_t(["기타비유동금융자산", "장기금융상품", "장기투자자산"])
    eq_mv = bs_t(["관계기업 및 공동기업 투자", "관계기업에 대한 투자", "관계기업투자"])

    identified = ar + inv + ppe + intan + cash + st_fi + lt_fi + eq_mv
    other_op   = max(0, total_a - identified) if total_a else 0

    op_total  = ar + inv + ppe + intan + other_op
    non_total = cash + st_fi + lt_fi + eq_mv

    # 값이 전혀 없으면 총자산 비율로 추정
    if op_total == 0 and total_a:
        op_total  = round(total_a * 0.46)
        non_total = total_a - op_total

    # 현금흐름
    ocf = amounts(_find_acct(idx, "CF", ["영업활동현금흐름", "영업활동으로 인한 현금흐름",
                                          "영업활동으로인한현금흐름", "영업활동 현금흐름"]))
    icf = amounts(_find_acct(idx, "CF", ["투자활동현금흐름", "투자활동으로 인한 현금흐름",
                                          "투자활동으로인한현금흐름", "투자활동 현금흐름"]))
    fcf = amounts(_find_acct(idx, "CF", ["재무활동현금흐름", "재무활동으로 인한 현금흐름",
                                          "재무활동으로인한현금흐름", "재무활동 현금흐름"]))

    # R&D 비용 (비용처리분) — 키워드 기반 스캔 (기업마다 계정명 상이)
    _RND_KEYWORDS = ["연구개발", "경상연구", "개발비용", "r&d", "연구비"]
    rnd_it = None
    rnd_acct_nm = None
    # idx는 (sj_div, account_nm) 튜플 키 → IS/CIS 항목 전체 스캔
    _rnd_candidates = []
    for (sj, nm_orig), it in idx.items():
        if sj not in IS_SECTS:
            continue
        nm = nm_orig.lower().replace(" ", "")
        for kw in _RND_KEYWORDS:
            if kw in nm:
                try:
                    _ord = int(it.get("ord", 9999))
                except (ValueError, TypeError):
                    _ord = 9999
                _rnd_candidates.append((_ord, it, nm_orig))
                break
    if _rnd_candidates:
        _rnd_candidates.sort(key=lambda x: x[0])
        _, rnd_it, rnd_acct_nm = _rnd_candidates[0]
    rnd      = amounts(rnd_it)
    # SG&A (판매비와관리비) — R&D가 통합 공시되는 대기업 용
    sga_it   = _find_acct(idx, IS_SECTS, ["판매비와관리비", "판매비 및 관리비",
                                           "판매비와 관리비"])
    sga      = amounts(sga_it)
    # 개발비 자산 (BS 자산화분)
    dev_it   = _find_acct(idx, "BS", ["개발비"])
    dev_cur  = _to_ok((dev_it or {}).get("thstrm_amount",  0))
    dev_prev = _to_ok((dev_it or {}).get("frmtrm_amount",  0))

    # 판매관리비 세부 항목
    _SGA_SUBS = [
        ["급여"],
        ["퇴직급여", "퇴직급여비용"],
        ["복리후생비"],
        ["감가상각비"],
        ["무형자산상각비"],
        ["임차료"],
        ["광고선전비", "광고비"],
        ["대손상각비", "매출채권손상차손"],
        ["지급수수료"],
        ["운반비", "운송비"],
        ["세금과공과"],
        ["접대비", "기업업무추진비"],
        ["수선비"],
        ["보험료"],
        ["판매수수료", "판매촉진비"],
        ["경상연구개발비"],
    ]
    sga_cur = abs(sga[0])
    sga_breakdown = []
    found_sum = 0
    for names in _SGA_SUBS:
        it = _find_acct(idx, IS_SECTS, names)
        if it:
            v = abs(_to_ok(it.get("thstrm_amount", 0)))
            if v > 0:
                sga_breakdown.append({"name": names[0], "amount": v})
                found_sum += v
    # 잔여분 → 기타
    if sga_breakdown and sga_cur > 0:
        residual = sga_cur - found_sum
        if residual > sga_cur * 0.03:
            sga_breakdown.append({"name": "기타", "amount": residual})

    # 영업외수익 항목 (당기)
    def is_t(names):
        it = _find_acct(idx, IS_SECTS, names)
        return _to_ok((it or {}).get("thstrm_amount", 0))

    interest_inc = is_t(["이자수익"])
    dividend_inc = is_t(["배당금수익", "배당금수입"])
    equity_inc   = is_t(["지분법이익", "지분법투자이익",
                          "관계기업 및 공동기업 관련 이익", "관계기업투자이익"])
    fin_inc_total = is_t(["금융수익"])   # 이자+배당 통합 공시 기업 대비

    # 금융수익으로만 공시된 경우 이자수익 대용
    if interest_inc == 0 and dividend_inc == 0 and fin_inc_total > 0:
        interest_inc = fin_inc_total

    non_op_total_inc = interest_inc + dividend_inc + equity_inc

    # CAPEX = |유형자산 취득| + |무형자산 취득|
    def _abs_amounts(it):
        if not it: return (0, 0, 0)
        return (abs(_to_ok(it.get("thstrm_amount",    0))),
                abs(_to_ok(it.get("frmtrm_amount",    0))),
                abs(_to_ok(it.get("bfefrmtrm_amount", 0))))

    ppe_acq = _abs_amounts(_find_acct(idx, "CF", ["유형자산의 취득", "유형자산 취득"]))
    int_acq = _abs_amounts(_find_acct(idx, "CF", ["무형자산의 취득", "무형자산 취득"]))
    capex_t = tuple(ppe_acq[i] + int_acq[i] for i in range(3))

    def _safe_pct(a, b):
        return round(a / b * 100, 1) if b else None

    roe_val         = _safe_pct(ni[0], total_eq)
    debt_ratio      = _safe_pct(total_l,   total_eq)
    roe_vals        = [None, _safe_pct(ni[1], total_eq_p), roe_val]
    debt_ratio_vals = [None, _safe_pct(total_l_p, total_eq_p), debt_ratio]

    return {
        "income_statement": {
            "years": years,
            "revenue":          [rev[2], rev[1], rev[0]],
            "operating_profit": [op[2],  op[1],  op[0]],
            "net_income":       [ni[2],  ni[1],  ni[0]],
            "operating_margin": [pct(op[2], rev[2]), pct(op[1], rev[1]), pct(op[0], rev[0])],
            "roe":              roe_vals,
            "debt_ratio":       debt_ratio_vals,
            "cogs":             cogs_cur,
            "sga":              sga_cur,
            "sga_breakdown":    sga_breakdown,
        },
        "balance_sheet": {
            "year": str(bsns_y),
            "operating_assets": {
                "유형자산":     ppe,
                "재고자산":     inv,
                "매출채권":     ar,
                "무형자산":     intan,
                "기타영업자산": other_op,
                "합계":         op_total,
            },
            "non_operating_assets": {
                "현금및현금성자산": cash,
                "단기금융자산":    st_fi,
                "장기금융자산":    lt_fi,
                "관계기업투자":    eq_mv,
                "합계":           non_total,
            },
            "non_op_income": {
                "이자수익":   interest_inc,
                "배당금수입": dividend_inc,
                "지분법이익": equity_inc,
                "합계":       non_op_total_inc,
            },
            "total_assets":      total_a,
            "total_liabilities": total_l,
            "total_equity":      total_eq,
        },
        "cash_flow": {
            "years": years,
            "operating_cf": [ocf[2], ocf[1], ocf[0]],
            "investing_cf":  [icf[2], icf[1], icf[0]],
            "financing_cf":  [fcf[2], fcf[1], fcf[0]],
            "capex":         [capex_t[2], capex_t[1], capex_t[0]],
        },
        "rnd": {
            "years":      years,
            "expense":    [abs(rnd[2]), abs(rnd[1]), abs(rnd[0])],
            "sga":        [abs(sga[2]), abs(sga[1]), abs(sga[0])],
            "dev_asset":  dev_cur,
            "dev_asset_prev": dev_prev,
            "account_nm": rnd_acct_nm,
        },
        "ratios": {
            "per": None, "pbr": None,
            "roe": roe_val,
            "eps": None, "bps": None,
            "debt_ratio": debt_ratio,
            "dividend_yield": None,
        },
        "_source": "dart",
    }


def get_dart_financials(stock_code):
    """종목코드로 DART 재무제표 조회. 연결 → 별도 순으로 시도."""
    _corps_ready.wait(timeout=10)
    entry = _corp_by_code.get(stock_code)
    if not entry:
        return None
    corp_code = entry["corp_code"]
    year = datetime.now().year - 1   # 직전 사업연도
    for fs_div in ("CFS", "OFS"):
        data = dart_financials_raw(corp_code, year, fs_div)
        if data and data.get("list"):
            app.logger.info(f"DART 재무({fs_div}) {stock_code}/{year}: {len(data['list'])}개 항목")
            return parse_dart_fin(data["list"])
    return None


_CORP_SUFFIX = re.compile(
    r'^(주식회사\s*|㈜\s*|\(주\)\s*)|([\s,]*(주식회사|\(주\)|㈜)[\s,]*$)'
)

def _clean_corp_name(name):
    """'(주)삼성전자' → '삼성전자',  '삼성전자 주식회사' → '삼성전자'"""
    return _CORP_SUFFIX.sub("", (name or "").strip()).strip()


# 한국표준산업분류(KSIC) 코드 → 업종명 (앞 2~4자리 기준)
_KSIC_MAP = {
    "011": "농업",        "012": "축산업",        "031": "수산업",
    "101": "식품",        "102": "식품",          "103": "음료",
    "110": "담배",        "131": "섬유",          "141": "의류",
    "151": "가죽/신발",   "161": "목재",          "170": "종이",
    "181": "인쇄",        "191": "코크스/석유",   "201": "기초화학",
    "202": "화학",        "203": "화학",          "204": "화학",
    "205": "화학",        "206": "화학",          "211": "의약",
    "212": "의약",        "221": "고무/플라스틱", "222": "고무/플라스틱",
    "231": "유리/요업",   "241": "철강",          "242": "비철금속",
    "251": "금속",        "281": "기계",          "282": "전지/배터리",
    "289": "기계",        "291": "자동차",        "301": "자동차",
    "302": "자동차부품",  "303": "자동차",        "311": "선박",
    "312": "선박",        "313": "항공기",
    "261": "반도체/전자", "262": "반도체",        "263": "통신장비",
    "264": "영상/가전",   "265": "계측기기",
    "271": "전기",        "272": "전기",          "273": "전기",
    "274": "전지",        "275": "전기",          "279": "전기",
    "351": "발전",        "352": "가스",          "360": "수도",
    "410": "건설",        "421": "건설",          "422": "건설",
    "431": "건설",        "432": "건설",
    "451": "자동차판매", "461": "도매",          "471": "소매",
    "491": "육상운송",   "492": "육상운송",      "511": "항공운송",
    "521": "해상운송",   "551": "숙박",          "561": "음식점",
    "612": "통신",        "613": "통신",          "619": "통신",
    "621": "IT서비스",    "622": "IT서비스",      "631": "정보서비스",
    "632": "포털/인터넷", "639": "IT서비스",
    "641": "은행",        "642": "은행",          "649": "금융",
    "651": "보험",        "652": "보험",          "661": "금융",
    "671": "부동산",      "681": "부동산",        "682": "부동산",
    "701": "전문서비스",  "702": "전문서비스",    "711": "연구개발",
    "712": "연구개발",    "713": "연구개발",
    "731": "광고",        "732": "광고",          "741": "전문서비스",
    "750": "수의업",      "761": "서비스",        "771": "서비스",
    "781": "서비스",      "791": "서비스",        "801": "교육",
    "861": "병원/의료",   "869": "사회서비스",
    "901": "예술/문화",   "911": "스포츠/여가",
}

def _induty_to_sector(code):
    """KSIC 5자리 코드 → 업종명. 앞 3자리로 매핑."""
    c = str(code or "").strip()
    if not c.isdigit():
        return "상장기업"
    for prefix_len in (3, 2):
        sect = _KSIC_MAP.get(c[:prefix_len])
        if sect:
            return sect
    return "상장기업"


def get_dart_company(stock_code):
    """DART 기업개황 조회"""
    _corps_ready.wait(timeout=10)
    entry = _corp_by_code.get(stock_code)
    if not entry:
        return None
    data = dart_company_info(entry["corp_code"])
    if not data:
        return None
    corp_cls = data.get("corp_cls", "")
    # stock_name이 더 깔끔 (법인형태 접두사 없음), 없으면 corp_name 정리
    name = data.get("stock_name") or _clean_corp_name(data.get("corp_name", entry["name"]))
    return {
        "name":        name,
        "market":      CORP_CLS_MAP.get(corp_cls, "기타"),
        "description": f"{data.get('adres', '')} | CEO: {data.get('ceo_nm', '-')} | 설립: {data.get('est_dt', '-')[:4]}년",
        "ceo":         data.get("ceo_nm", ""),
        "address":     data.get("adres", ""),
        "sector":      _induty_to_sector(data.get("induty_code", "")),
    }

# ── Flask 라우트 ─────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])

    results = []
    if _corps_ready.is_set() and _corp_list:
        seen    = set()
        matched = []
        for entry in _corp_list:
            name = entry["name"]
            sc   = entry["stock_code"]
            # 매칭 점수: 0=정확일치 1=접두사 2=포함
            if q == name or q == sc:
                score = 0
            elif name.startswith(q):
                score = 1
            elif q in name or q in sc:
                score = 2
            else:
                continue
            if sc in seen:
                continue
            seen.add(sc)
            dummy = COMPANIES.get(sc, {})
            matched.append({
                "code":   sc,
                "name":   _clean_corp_name(name),
                "sector": dummy.get("sector", "상장기업"),
                "market": dummy.get("market", "KOSPI"),
                "_score": score,
            })
        # 정확일치·접두사 우선, 동점이면 이름 가나다순
        matched.sort(key=lambda x: (x["_score"], x["name"]))
        for item in matched[:8]:
            item.pop("_score")
            results.append(item)
    else:
        for code, info in COMPANIES.items():
            if q in info["name"] or q in code:
                results.append({"code": code, "name": info["name"],
                                 "sector": info["sector"], "market": info["market"]})

    return jsonify(results[:8])


@app.route("/api/stock/<code>")
def get_stock(code):
    # 기본 기업 정보 (더미 우선, DART 보완)
    dummy = COMPANIES.get(code)
    dart_info = get_dart_company(code) if DART_KEY else None

    if dummy:
        info = dict(dummy)
        if dart_info:
            info["description"] = dart_info["description"]
            if dart_info["market"]: info["market"] = dart_info["market"]
    elif dart_info:
        # DART에서 찾은 미등록 종목
        info = {
            "name":          dart_info["name"],
            "code":          code,
            "sector":        dart_info.get("sector") or "상장기업",
            "market":        dart_info["market"],
            "current_price": 0,
            "prev_price":    0,
            "market_cap":    0,
            "shares":        0,
            "w52_high":      0,
            "w52_low":       0,
            "description":   dart_info["description"],
        }
    else:
        return jsonify({"error": "종목을 찾을 수 없습니다"}), 404

    # Naver/Yahoo Finance 실시간 주가로 덮어쓰기
    yp = _fetch_realtime_price(code)
    if yp:
        info["current_price"] = yp["current_price"]
        info["prev_price"]    = yp["prev_price"]
        if yp["w52_high"]:   info["w52_high"]   = yp["w52_high"]
        if yp["w52_low"]:    info["w52_low"]     = yp["w52_low"]
        if yp["market_cap"]: info["market_cap"]  = yp["market_cap"]
        if yp["market"]:     info["market"]      = yp["market"]
        info["_price_source"] = "realtime"
    else:
        info["_price_source"] = "dummy"

    # DART 보통주 발행주식 총수로 덮어쓰기
    dart_shares = _fetch_dart_shares(code)
    if dart_shares:
        info["shares"] = dart_shares

    # 실시간 주가 히스토리 (Yahoo Finance 3개월 일봉, 실패 시 더미 폴백)
    hist = _fetch_price_history(code)
    if hist:
        dates, prices = hist["dates"], hist["prices"]
    else:
        dates, prices = gen_prices(info["current_price"] or 10000, hash(code) % 9999)
        hist = {"_source": "dummy"}

    # 등락 — Naver가 직접 제공하면 사용 (시장 마감 시에도 정확), 아니면 직접 계산
    if yp and "change" in yp:
        change     = yp["change"]
        change_pct = yp["change_pct"]
    else:
        diff       = info["current_price"] - info["prev_price"]
        change     = diff
        change_pct = round(diff / info["prev_price"] * 100, 2) if info["prev_price"] else 0.0

    # 재무 요약 (DART 우선, 더미 폴백)
    dart_fin = get_dart_financials(code) if DART_KEY else None
    fin = dart_fin or FINANCIALS.get(code, FINANCIALS["005930"])

    # Naver Finance PER·PBR·EPS·BPS·배당으로 ratios 덮어쓰기 (yp는 위에서 이미 조회)
    ratios = dict(fin["ratios"])
    if yp:
        if yp.get("per")           is not None: ratios["per"]            = yp["per"]
        if yp.get("pbr")           is not None: ratios["pbr"]            = yp["pbr"]
        if yp.get("eps")           is not None: ratios["eps"]            = yp["eps"]
        if yp.get("bps")           is not None: ratios["bps"]            = yp["bps"]
        if yp.get("dividend_yield") is not None: ratios["dividend_yield"] = yp["dividend_yield"]
        ratios["_ratio_source"] = "naver"
    else:
        ratios.setdefault("_ratio_source", "dart" if dart_fin else "dummy")

    employees = _fetch_dart_employees(code) if DART_KEY else None

    return jsonify({
        "info": {**info, "change": change, "change_pct": change_pct,
                 "employees": employees,
                 "_fin_source": fin.get("_source", "dummy"),
                 "_chart_source": hist.get("_source", "dummy")},
        "price_history": {"dates": dates, "prices": prices},
        "ratios":         ratios,
        "income_summary": {
            "years":            fin["income_statement"]["years"],
            "revenue":          fin["income_statement"]["revenue"],
            "operating_profit": fin["income_statement"]["operating_profit"],
        },
    })


@app.route("/api/price-history/<code>")
def get_price_history(code):
    period = request.args.get("period", "3mo")
    if period not in ("3mo", "6mo", "1y"):
        period = "3mo"
    hist = _fetch_price_history(code, period)
    if hist:
        return jsonify(hist)
    # 더미 폴백
    cur = COMPANIES.get(code, {}).get("current_price", 10000)
    dates, prices = gen_prices(cur, hash(code) % 9999)
    return jsonify({"dates": dates, "prices": prices, "_source": "dummy"})


@app.route("/api/financials/<code>")
def get_financials(code):
    if DART_KEY:
        dart_fin = get_dart_financials(code)
        if dart_fin:
            return jsonify(dart_fin)
    return jsonify(FINANCIALS.get(code, FINANCIALS["005930"]))


@app.route("/api/employees/<code>")
def get_employee_stats(code):
    """3개년 직원현황 (총원·성별·고용형태·평균급여)."""
    if not DART_KEY:
        return jsonify({"years": [], "error": "DART API 키 없음"})
    _corps_ready.wait(5)
    entry = _corp_by_code.get(code)
    if not entry:
        return jsonify({"years": [], "error": "종목 없음"})

    corp_code = entry["corp_code"]
    cur_year  = datetime.now().year
    year_rows = []

    for year in range(cur_year - 1, cur_year - 4, -1):
        data = _dart_get("empSttus.json", {
            "corp_code": corp_code, "bsns_year": str(year), "reprt_code": "11011",
        })
        if data and data.get("list"):
            parsed = _parse_emp_year(data["list"])
            if parsed["total"] > 0:
                parsed["year"] = str(year)
                year_rows.append(parsed)

    if not year_rows:
        return jsonify({"years": [], "error": "직원현황 데이터 없음"})

    year_rows.sort(key=lambda x: x["year"])
    return jsonify({
        "years":      [d["year"]       for d in year_rows],
        "total":      [d["total"]      for d in year_rows],
        "male":       [d["male"]       for d in year_rows],
        "female":     [d["female"]     for d in year_rows],
        "regular":    [d["regular"]    for d in year_rows],
        "contract":   [d["contract"]   for d in year_rows],
        "avg_salary": [d["avg_salary"] for d in year_rows],
    })


@app.route("/api/competitors/<code>")
def get_competitors(code):
    from concurrent.futures import ThreadPoolExecutor

    # 수동 경쟁사 목록 → 없으면 Naver 동종업종 자동 탐색
    comp_entries   = COMPETITORS.get(code, [])
    naver_peer_map = {}
    if not comp_entries:
        naver_peers  = _fetch_naver_industry_peers(code)
        comp_entries = [{"code": p["code"], "name": p["name"]} for p in naver_peers]
        naver_peer_map = {p["code"]: p for p in naver_peers}

    all_codes = [code] + [c["code"] for c in comp_entries]

    # DART 재무 + 실시간 주가 + 섹터 병렬 조회
    dart_results   = {}
    price_results  = {}
    sector_results = {}

    def _fetch_one(c):
        dart_fin = get_dart_financials(c) if DART_KEY else None
        rt_price = _fetch_realtime_price(c)
        sector   = COMPANIES.get(c, {}).get("sector")
        if not sector and DART_KEY:
            dart_co = get_dart_company(c)
            sector  = (dart_co or {}).get("sector", "상장기업")
        return c, dart_fin, rt_price, sector or "상장기업"

    with ThreadPoolExecutor(max_workers=min(len(all_codes), 8)) as ex:
        for c, dart_fin, rt_price, sector in ex.map(_fetch_one, all_codes):
            dart_results[c]   = dart_fin
            price_results[c]  = rt_price
            sector_results[c] = sector

    rows = []
    for i, c in enumerate(all_codes):
        dart_fin  = dart_results.get(c)
        dummy_fin = FINANCIALS.get(c, FINANCIALS["005930"])
        dummy_co  = COMPANIES.get(c, {})

        fin = dart_fin if dart_fin else dummy_fin
        is_ = fin["income_statement"]
        rt  = fin["ratios"]

        # 기업명: Naver peer 이름 → DART corp 이름 → dummy 이름 순으로 정리
        naver_peer = naver_peer_map.get(c, {})
        corp_entry = _corp_by_code.get(c, {})
        raw_name   = (naver_peer.get("name") or corp_entry.get("name")
                      or dummy_co.get("name", c))
        name = _clean_corp_name(raw_name)

        # 실시간 주가 데이터
        yp = price_results.get(c)

        # 시가총액: Naver 실시간 우선 → Naver peer값 → dummy
        if yp and yp.get("market_cap"):
            market_cap = yp["market_cap"]
        elif naver_peer.get("market_cap"):
            market_cap = naver_peer["market_cap"]
        else:
            market_cap = dummy_co.get("market_cap", 0)

        # PER/PBR: Naver 실시간 우선
        per = yp.get("per") if yp else rt.get("per")
        pbr = yp.get("pbr") if yp else rt.get("pbr")

        rev   = is_["revenue"][-1]
        op    = is_["operating_profit"][-1]
        ni    = is_["net_income"][-1]
        op_mg = round(op / rev * 100, 1) if rev else 0.0
        yr    = is_["years"][-1]

        rows.append({
            "code":          c,
            "name":          name,
            "sector":        sector_results.get(c, "상장기업"),
            "market_cap":    market_cap,
            "year":          yr,
            "revenue":       rev,
            "op_profit":     op,
            "net_income":    ni,
            "op_margin":     op_mg,
            "per":           per,
            "pbr":           pbr,
            "roe":           rt.get("roe"),
            "is_main":       i == 0,
            "_source":       fin.get("_source", "dummy"),
            "_price_source": "realtime" if yp else "dummy",
        })

    return jsonify(rows)


def _analyze_dart(code, fin):
    """DART 실재무 데이터 → 규칙기반 투자분석 보고서 자동 생성"""
    is_  = fin["income_statement"]
    bs   = fin["balance_sheet"]
    cf   = fin["cash_flow"]
    rt   = fin["ratios"]

    years = is_["years"]
    n     = len(years)
    rev   = is_["revenue"]
    op    = is_["operating_profit"]
    ni    = is_["net_income"]
    opm   = is_["operating_margin"]

    # ── 성장 지표 ─────────────────────────────────────────────
    rev_yoy = round((rev[-1] / rev[-2] - 1) * 100, 1) if rev[-2] else 0.0
    op_yoy  = round((op[-1]  / op[-2]  - 1) * 100, 1) if op[-2] and op[-2] != 0 else 0.0
    cagr    = round(((rev[-1] / rev[0]) ** (1 / (n - 1)) - 1) * 100, 1) if rev[0] and n > 1 else 0.0
    opm_chg = round(opm[-1] - opm[0], 1)

    # ── 수익성 ────────────────────────────────────────────────
    opm_cur = opm[-1]
    roe     = rt.get("roe") or 0.0
    nm_pct  = round(ni[-1] / rev[-1] * 100, 1) if rev[-1] else 0.0

    # ── 재무건전성 ────────────────────────────────────────────
    dr      = rt.get("debt_ratio") or 0.0
    ocf_cur = cf["operating_cf"][-1]
    icf_cur = cf["investing_cf"][-1]
    free_cf = ocf_cur + icf_cur

    # ── 주당 지표 ──────────────────────────────────────────────
    dummy       = COMPANIES.get(code, {})
    dart_shares = _fetch_dart_shares(code)
    shares      = dart_shares or dummy.get("shares", 0)

    # 실시간 주가 + 컨센서스 데이터 (Naver)
    yp               = _fetch_realtime_price(code)
    cur_px           = (yp["current_price"] if yp else None) or dummy.get("current_price", 0)
    consensus_target = yp.get("consensus_target") if yp else None
    recomm_mean      = yp.get("recomm_mean")      if yp else None

    # Naver BPS 우선 (실시간), 없으면 DART 계산값
    naver_bps = yp.get("bps") if yp else None
    eps = round(ni[-1] * 1e8 / shares) if shares else None
    bps = naver_bps or (round(bs["total_equity"] * 1e8 / shares) if shares else None)

    # ── 목표주가 ──────────────────────────────────────────────
    # 1순위: 애널리스트 컨센서스 (Naver)
    # 2순위: P/B 정당가치 모델 (ROE/Ke × BPS)
    pb_target = None
    if bps and roe and roe > 0:
        ke     = 8.5
        jpb    = min(max(round(roe / ke, 2), 0.4), 6.0)
        pb_target = round(bps * jpb / 500) * 500

    if consensus_target and cur_px:
        target_px      = consensus_target
        target_source  = "consensus"
        upside         = round((target_px - cur_px) / cur_px * 100, 1)
    elif pb_target and cur_px:
        target_px      = pb_target
        target_source  = "pb_model"
        upside         = round((target_px - cur_px) / cur_px * 100, 1)
    else:
        target_px = upside = target_source = None

    # ── 레이팅 ────────────────────────────────────────────────
    # 컨센서스 추천지수 우선(1=강력매도~5=강력매수), 없으면 재무 점수
    if recomm_mean is not None:
        if   recomm_mean >= 4.5: rating = "강력매수"
        elif recomm_mean >= 3.5: rating = "매수"
        elif recomm_mean >= 2.5: rating = "중립"
        elif recomm_mean >= 1.5: rating = "비중축소"
        else:                    rating = "매도"
        rating_source = "consensus"
    else:
        s = 0
        if   rev_yoy > 20:   s += 3
        elif rev_yoy > 10:   s += 2
        elif rev_yoy > 3:    s += 1
        elif rev_yoy < -10:  s -= 2
        elif rev_yoy < 0:    s -= 1
        if   opm_cur > 30:   s += 3
        elif opm_cur > 15:   s += 2
        elif opm_cur > 8:    s += 1
        elif opm_cur < 2:    s -= 3
        elif opm_cur < 5:    s -= 2
        if   opm_chg > 8:    s += 1
        elif opm_chg < -8:   s -= 1
        if   roe > 25:       s += 2
        elif roe > 12:       s += 1
        elif roe < 3:        s -= 2
        elif roe < 7:        s -= 1
        if   dr < 50:        s += 1
        elif dr > 200:       s -= 2
        elif dr > 100:       s -= 1
        if   free_cf > 0:    s += 1
        elif free_cf < 0:    s -= 1
        if   s >= 7:  rating = "강력매수"
        elif s >= 4:  rating = "매수"
        elif s >= 1:  rating = "중립"
        elif s >= -1: rating = "비중축소"
        else:         rating = "매도"
        rating_source = "model"

    # ── 강점 생성 ─────────────────────────────────────────────
    strengths = []
    if rev_yoy > 15:
        strengths.append(f"강한 매출 성장 (YoY +{rev_yoy}%) — 수요 모멘텀 견조")
    elif rev_yoy > 3:
        strengths.append(f"안정적 매출 증가 (YoY +{rev_yoy}%)")
    if opm_cur > 30:
        strengths.append(f"업계 최상위 영업이익률 ({opm_cur}%) — 독보적 가격 결정력")
    elif opm_cur > 15:
        strengths.append(f"높은 영업이익률 ({opm_cur}%) — 강한 수익 창출력")
    elif opm_cur > 8:
        strengths.append(f"견조한 영업이익률 ({opm_cur}%)")
    if opm_chg > 5:
        strengths.append(f"OPM {opm_chg:+.1f}%p 개선 ({years[0]}→{years[-1]}) — 수익 구조 강화")
    if roe > 20:
        strengths.append(f"높은 ROE ({roe}%) — 자기자본 효율적 운용")
    elif roe > 10:
        strengths.append(f"양호한 ROE ({roe}%)")
    if free_cf > 0 and ocf_cur > 0:
        strengths.append(f"양(+) FCF ({free_cf // 10000:,}억원) — 자체 투자·환원 여력")
    if dr < 50:
        strengths.append(f"낮은 부채비율 ({dr}%) — 재무건전성 우수")
    if not strengths:
        strengths = ["안정적 사업 기반과 브랜드 파워", "시장 지배적 포지션 보유"]

    # ── 리스크 생성 ───────────────────────────────────────────
    risks = []
    if rev_yoy < 0:
        risks.append(f"매출 역성장 (YoY {rev_yoy}%) — 수요 회복 불확실")
    if opm_cur < 5:
        risks.append(f"낮은 영업이익률 ({opm_cur}%) — 비용 구조 개선 과제")
    elif opm_chg < -5:
        risks.append(f"OPM {opm_chg:.1f}%p 하락 추세 — 마진 압박 지속 우려")
    if dr > 150:
        risks.append(f"높은 부채비율 ({dr}%) — 재무 레버리지 리스크")
    if free_cf < 0:
        risks.append(f"음(-) FCF ({free_cf // 10000:,}억원) — 대규모 투자 부담")
    if roe < 7:
        risks.append(f"낮은 ROE ({roe}%) — 자기자본 수익성 개선 필요")
    risks.append("글로벌 경기 불확실성 · 환율 변동 리스크")
    if len(risks) < 2:
        risks.append("경쟁 심화에 따른 시장 지위 유지 부담")

    # ── 촉매 생성 ─────────────────────────────────────────────
    catalysts = []
    if icf_cur < -50000:
        catalysts.append(f"대규모 CAPEX ({abs(icf_cur) / 10000:.1f}조원) 투자 성과 가시화 기대")
    if opm_chg > 0:
        catalysts.append("수익성 개선 추세 지속 시 멀티플 재평가 가능")
    catalysts.append("주주환원 정책(배당·자사주 매입) 강화 가능성")
    if upside and upside > 10:
        catalysts.append(f"현재가 저평가 구간 — 목표주가 대비 +{upside:.1f}% 상승 여력")

    # ── 종합 요약 ─────────────────────────────────────────────
    nm_str = dummy.get("name") or code

    grow_c = (f"매출이 전년 대비 {rev_yoy:+.1f}% 성장하며"
              if rev_yoy > 0 else f"매출이 전년 대비 {rev_yoy:.1f}% 감소하는 가운데")
    if   opm_cur >= 25: prft_c = f"영업이익률 {opm_cur}%의 탁월한 수익성 시현"
    elif opm_cur >= 12: prft_c = f"영업이익률 {opm_cur}%로 양호한 수익성 유지"
    elif opm_cur >= 5:  prft_c = f"영업이익률 {opm_cur}%로 수익성 점진적 회복"
    else:               prft_c = f"영업이익률 {opm_cur}%로 수익성 개선 필요"

    hlth_c = "재무 구조는 안정적" if dr < 80 else f"부채비율 {dr}%로 재무 관리 필요"

    summary = (
        f"{nm_str}은(는) {years[-1]}년 기준 {grow_c} "
        f"{prft_c}하고 있습니다. "
        f"ROE {roe}%, 부채비율 {dr}%로 {hlth_c}입니다."
    )
    if target_px and upside is not None:
        src_label = "애널리스트 컨센서스" if target_source == "consensus" else "P/B 정당가치 모델"
        summary += f" {src_label} 기준 목표주가 {target_px:,}원 (현재가 대비 {upside:+.1f}%)."
    if recomm_mean is not None:
        summary += f" 애널리스트 평균 투자의견 {recomm_mean:.2f}/5.00."

    return {
        "rating":          rating,
        "rating_source":   rating_source,
        "target_price":    target_px or cur_px,
        "target_source":   target_source,
        "pb_target":       pb_target,          # P/B 모델 참고값
        "current_price":   cur_px,
        "upside":          upside or 0.0,
        "recomm_mean":     recomm_mean,
        "summary":         summary,
        "strengths":       strengths[:4],
        "risks":           risks[:4],
        "catalysts":       catalysts[:3],
        "metrics": {
            "rev_yoy":    rev_yoy,
            "op_yoy":     op_yoy,
            "cagr":       cagr,
            "opm":        opm_cur,
            "opm_trend":  opm_chg,
            "roe":        roe,
            "net_margin": nm_pct,
            "debt_ratio": dr,
            "fcf":        free_cf,
            "ocf":        ocf_cur,
            "eps":        eps,
            "bps":        bps,
        },
        "years":   years,
        "analyst": f"DART 재무분석 엔진 v3.1 (기준: {years[-1]}년)",
        "date":    datetime.now().strftime("%Y-%m-%d"),
        "_source": "dart",
    }


def _dart_int(s):
    try:
        return int(str(s or "0").replace(",", "").strip())
    except:
        return 0


def _parse_pay_list(items):
    """DART indvdlByPay 목록 → 정렬된 보수 리스트."""
    result = []
    for item in (items or []):
        nm = (item.get("nm") or "").strip()
        if not nm or nm == "-":
            continue
        raw = _dart_int(item.get("mendng_totamt"))
        result.append({
            "name":       nm,
            "position":   (item.get("ofcps")    or "").strip(),
            "amount_won": raw,
            "amount_ok":  round(raw / 100_000_000, 1),
            "period":     (item.get("stlm_dt")  or "").strip(),
        })
    result.sort(key=lambda x: x["amount_ok"], reverse=True)
    return result


def _parse_reg_comp(items):
    """DART hmvAuditIndvdlBySttus 목록 → 등기임원 개인별 보수 리스트."""
    result = []
    for item in (items or []):
        nm = (item.get("nm") or "").strip()
        if not nm or nm == "-":
            continue
        raw = _dart_int(item.get("mendng_totamt"))
        if raw <= 0:
            continue
        result.append({
            "name":      nm,
            "position":  (item.get("ofcps") or "").strip(),
            "amount_ok": round(raw / 100_000_000, 2),
        })
    result.sort(key=lambda x: -x["amount_ok"])
    return result


def _calc_exec_grade(metrics, ceo_pay_ok):
    """보수/성과 기반 AI 종합 등급 (A+/A/B+/B/C)."""
    score     = 0
    issues    = []
    strengths = []

    pay_to_op = metrics.get("ceo_pay_to_op_pct")
    pay_yoy   = metrics.get("pay_yoy_pct")
    op_yoy    = metrics.get("op_profit_yoy_pct")
    salary_x  = metrics.get("ceo_to_avg_salary_x")
    roe_vals  = metrics.get("roe_vals") or []
    roe_cur   = next((v for v in reversed(roe_vals) if v is not None), None)

    if pay_to_op is not None:
        if pay_to_op < 0.5:   score += 3; strengths.append(f"보수/영업이익 {pay_to_op:.2f}% 매우 낮음")
        elif pay_to_op < 2.0: score += 2; strengths.append(f"보수/영업이익 {pay_to_op:.2f}% 양호")
        elif pay_to_op < 5.0: score += 1
        else:                 score -= 1; issues.append(f"보수/영업이익 {pay_to_op:.1f}% 높음")

    if pay_yoy is not None and op_yoy is not None:
        if pay_yoy > 10 and op_yoy < -10:
            score -= 2
            issues.append(f"실적 하락({op_yoy:+.1f}%)에도 보수 증가({pay_yoy:+.1f}%)")
        elif pay_yoy > 0 and op_yoy > pay_yoy:
            score += 1; strengths.append("이익 성장률 > 보수 증가율")

    if roe_cur is not None:
        if roe_cur > 20:   score += 3; strengths.append(f"ROE {roe_cur:.1f}% 우수")
        elif roe_cur > 10: score += 2; strengths.append(f"ROE {roe_cur:.1f}% 양호")
        elif roe_cur > 0:  score += 1
        else:              score -= 1; issues.append(f"ROE {roe_cur:.1f}% 적자")

    if salary_x is not None:
        if salary_x < 30:   score += 1; strengths.append(f"직원 대비 CEO 보수 {salary_x:.0f}배")
        elif salary_x > 80: score -= 1; issues.append(f"직원 대비 CEO 보수 {salary_x:.0f}배")

    if score >= 7:    letter, color = "A+", "#3fb950"
    elif score >= 5:  letter, color = "A",  "#3fb950"
    elif score >= 3:  letter, color = "B+", "#d29922"
    elif score >= 1:  letter, color = "B",  "#d29922"
    else:             letter, color = "C",  "#f85149"

    comment = " · ".join((issues + strengths)[:2]) if (issues or strengths) else "데이터 부족"
    return {"grade": letter, "color": color, "score": score,
            "comment": comment, "issues": issues, "strengths": strengths}


def _fetch_dart_executives(code):
    """임원현황·보수·주주·재무·직원 통합 조회. 6시간 캐시."""
    from concurrent.futures import ThreadPoolExecutor

    now    = datetime.now()
    cached = _exec_cache.get(code)
    if cached and (now - cached["ts"]).total_seconds() < _EXEC_TTL:
        return cached["data"]
    if not DART_KEY:
        return None
    _corps_ready.wait(5)
    entry = _corp_by_code.get(code)
    if not entry:
        return None

    corp_code = entry["corp_code"]
    cur_year  = datetime.now().year

    # ── 1. 임원 현황 (연도 결정) ─────────────────────────────────
    year_used  = None
    executives = []
    for year in range(cur_year - 1, cur_year - 3, -1):
        raw = _dart_get("exctvSttus.json", {
            "corp_code": corp_code, "bsns_year": str(year), "reprt_code": "11011",
        })
        if raw and raw.get("list"):
            year_used = year
            for item in raw["list"]:
                nm = (item.get("nm") or "").strip()
                if not nm or nm == "-":
                    continue
                reg_raw = str(item.get("rgbln_at") or "").strip()
                fte_raw = str(item.get("fte_at")   or "").strip()
                executives.append({
                    "name":           nm,
                    "gender":         (item.get("sexdstn")              or "").strip(),
                    "birth_ym":       (item.get("birth_ym")             or "").strip(),
                    "position":       (item.get("ofcps")                or "").strip(),
                    "registered":     reg_raw not in ("N", "미등기", "0"),
                    "full_time":      fte_raw in ("Y", "상근", "1", "상근임원"),
                    "role":           (item.get("chrg_job")             or "").strip(),
                    "career":         (item.get("main_career")          or "").strip(),
                    "shareholder_rel":(item.get("mxmm_shrholdr_relate") or "").strip(),
                    "tenure":         (item.get("hffc_pd")              or "").strip(),
                    "tenure_end":     (item.get("tenure_end_on")        or "").strip(),
                })
            break

    if year_used is None:
        return None

    prev_year = year_used - 1

    # ── 2. 병렬 API 조회 ─────────────────────────────────────────
    def _g(api, yr, extra=None):
        p = {"corp_code": corp_code, "bsns_year": str(yr), "reprt_code": "11011"}
        if extra:
            p.update(extra)
        return _dart_get(api, p)

    with ThreadPoolExecutor(max_workers=6) as ex:
        f_pay_cur  = ex.submit(_g, "indvdlByPay.json",           year_used)
        f_pay_prev = ex.submit(_g, "indvdlByPay.json",           prev_year)
        f_reg_comp = ex.submit(_g, "hmvAuditIndvdlBySttus.json", year_used)
        f_major    = ex.submit(_g, "majorstock.json",            year_used)
        f_emp      = ex.submit(_g, "empSttus.json",              year_used)
        f_fin      = ex.submit(get_dart_financials, code)

    compensation      = _parse_pay_list((f_pay_cur.result()  or {}).get("list"))
    compensation_prev = _parse_pay_list((f_pay_prev.result() or {}).get("list"))
    reg_comp          = _parse_reg_comp((f_reg_comp.result() or {}).get("list"))
    major_data        = f_major.result()
    emp_data          = f_emp.result()
    fin               = f_fin.result()

    # ── 3. 최대주주 ──────────────────────────────────────────────
    shareholders = []
    if major_data and major_data.get("list"):
        hmap = {}
        for it in major_data["list"]:
            nm = (it.get("repror") or "").strip()
            try:
                rt = float(str(it.get("stkrt") or "0").replace(",", ""))
            except:
                rt = 0.0
            if nm and (nm not in hmap or rt > hmap[nm]):
                hmap[nm] = rt
        shareholders = [{"name": n, "ratio": r}
                        for n, r in sorted(hmap.items(), key=lambda x: -x[1])[:6]]

    # ── 4. 직원 평균급여 ─────────────────────────────────────────
    avg_salary_won = None
    emp_total      = 0
    if emp_data and emp_data.get("list"):
        items      = emp_data["list"]
        total_sal  = 0
        total_head = 0
        for it in items:
            fo  = str(it.get("fo_bbm")  or "").strip()
            if fo not in ("성별합계", "합계", "계"):
                continue
            total_head += _dart_int(it.get("sm"))
            fyer = str(it.get("fyer_salary_totamt") or "").replace(",", "").strip()
            try:
                if fyer and fyer != "-":
                    total_sal += int(fyer)
            except:
                pass

        if total_head > 0:
            emp_total = total_head
            if total_sal > 0:
                avg_salary_won = total_sal / total_head
            else:
                # jan_salary_am fallback (남성 성별합계 행)
                for it in items:
                    fo  = str(it.get("fo_bbm")  or "").strip()
                    sex = str(it.get("sexdstn") or "").strip()
                    jan = str(it.get("jan_salary_am") or "").replace(",", "").strip()
                    if fo == "성별합계" and sex in ("남", "남성") and jan and jan != "-":
                        try:
                            avg_salary_won = float(jan)
                        except:
                            pass
                        break

    if emp_total == 0:
        emp_total = _fetch_dart_employees(code) or 0

    # ── 5. CEO 식별 ──────────────────────────────────────────────
    ceo = None
    for e in executives:
        if "대표이사" in (e.get("position") or "") or "대표이사" in (e.get("role") or ""):
            ceo = e; break
    if not ceo:
        for e in executives:
            if e.get("full_time"):
                ceo = e; break

    ceo_pay_ok      = None
    ceo_pay_prev_ok = None
    ceo_nm = ceo["name"] if ceo else ""
    if compensation:
        for c in compensation:
            if c["name"] == ceo_nm:
                ceo_pay_ok = c["amount_ok"]; break
    # indvdlByPay에 없으면 hmvAuditIndvdlBySttus에서 보완
    if ceo_pay_ok is None and reg_comp:
        for c in reg_comp:
            if c["name"] == ceo_nm:
                ceo_pay_ok = c["amount_ok"]; break
    # 그래도 없으면 최고보수자로 fallback
    if ceo_pay_ok is None and compensation:
        ceo_pay_ok = compensation[0]["amount_ok"]

    if compensation_prev and ceo:
        for c in compensation_prev:
            if c["name"] == ceo["name"]:
                ceo_pay_prev_ok = c["amount_ok"]; break

    # ── 6. 성과 지표 계산 ────────────────────────────────────────
    metrics = {}
    if fin:
        is_    = fin.get("income_statement", {})
        op_    = is_.get("operating_profit", [])
        rev_   = is_.get("revenue",          [])
        roe_   = is_.get("roe",              [None, None, None])
        debt_  = is_.get("debt_ratio",       [None, None, None])
        yrs_   = is_.get("years",            [])

        metrics.update({"years_fin": yrs_, "rev_list": rev_,
                         "op_list": op_, "roe_vals": roe_, "debt_vals": debt_})

        if op_ and len(op_) >= 1:
            op_cur  = op_[-1]
            op_prev = op_[-2] if len(op_) >= 2 else None

            if ceo_pay_ok and op_cur and op_cur > 0:
                metrics["ceo_pay_to_op_pct"] = round(ceo_pay_ok / op_cur * 100, 3)

            if op_prev is not None and op_prev != 0:
                metrics["op_profit_yoy_pct"] = round((op_cur - op_prev) / abs(op_prev) * 100, 1)

            if emp_total > 0:
                metrics["per_employee_op_ok"] = round(op_cur / emp_total, 4)

    if ceo_pay_ok and ceo_pay_prev_ok and ceo_pay_prev_ok > 0:
        metrics["pay_yoy_pct"] = round(
            (ceo_pay_ok - ceo_pay_prev_ok) / ceo_pay_prev_ok * 100, 1)

    if ceo_pay_ok and avg_salary_won and avg_salary_won > 0:
        metrics["ceo_to_avg_salary_x"] = round(
            (ceo_pay_ok * 100_000_000) / avg_salary_won, 1)

    # 오너일가 임원
    _owner_kw = ("본인", "배우자", "자녀", "부모", "형제", "친족")
    owner_execs = [e["name"] for e in executives
                   if e.get("registered")
                   and any(k in (e.get("shareholder_rel") or "") for k in _owner_kw)]

    # ── 7. AI 등급 ───────────────────────────────────────────────
    grade = _calc_exec_grade(metrics, ceo_pay_ok)

    result = {
        "year":              year_used,
        "_source":           "dart",
        "executives":        executives,
        "ceo":               ceo,
        "ceo_pay_ok":        ceo_pay_ok,
        "ceo_pay_prev_ok":   ceo_pay_prev_ok,
        "compensation":      compensation,
        "compensation_prev": compensation_prev,
        "reg_comp":          reg_comp,
        "shareholders":      shareholders,
        "owner_execs":       owner_execs,
        "avg_salary_won":    avg_salary_won,
        "emp_total":         emp_total,
        "metrics":           metrics,
        "grade":             grade,
    }
    _exec_cache[code] = {"data": result, "ts": now}
    return result


@app.route("/api/executives/<code>")
def get_executives(code):
    if DART_KEY:
        data = _fetch_dart_executives(code)
        if data and data.get("executives"):
            return jsonify(data)
    dummy_year = datetime.now().year - 1
    return jsonify({
        "year": dummy_year, "_source": "dummy",
        "executives": [
            {"name": "대표이사 A", "gender": "남", "birth_ym": "", "position": "대표이사",
             "registered": True,  "full_time": True,  "role": "경영총괄",
             "career": "", "shareholder_rel": "해당없음", "tenure": "", "tenure_end": ""},
            {"name": "사외이사 B", "gender": "남", "birth_ym": "", "position": "사외이사",
             "registered": True,  "full_time": False, "role": "이사회",
             "career": "", "shareholder_rel": "해당없음", "tenure": "", "tenure_end": ""},
        ],
        "ceo": {"name": "대표이사 A", "position": "대표이사", "role": "경영총괄",
                "career": "", "tenure": "", "tenure_end": "", "full_time": True, "registered": True,
                "gender": "남", "birth_ym": "", "shareholder_rel": "해당없음"},
        "ceo_pay_ok": None, "ceo_pay_prev_ok": None,
        "compensation": [], "compensation_prev": [],
        "shareholders": [], "owner_execs": [],
        "avg_salary_won": None, "emp_total": 0,
        "metrics": {}, "grade": {"grade": "-", "color": "#7d8590", "score": 0,
                                  "comment": "DART API 키 미설정", "issues": [], "strengths": []},
    })


@app.route("/api/export-markets/<code>")
def get_export_markets(code):
    """수출국·고객사 데이터. 큐레이팅 데이터 우선, 없으면 DART 기업정보 기반 부분 응답."""
    base = EXPORT_DATA.get(code)
    dart_co = get_dart_company(code) if DART_KEY else None
    co_entry = COMPANIES.get(code, {})

    if base:
        return jsonify({
            **base,
            "company_desc": (dart_co or {}).get("description", co_entry.get("description", "")),
            "sector":        (dart_co or {}).get("sector",      co_entry.get("sector", "")),
            "_source": "curated",
        })

    # 큐레이팅 없는 종목: DART 재무 데이터 기반 부분 응답
    sector = (dart_co or {}).get("sector") or co_entry.get("sector", "")
    fin = get_dart_financials(code) if DART_KEY else None
    rev_list = op_list = years = []
    if fin:
        is_ = fin.get("income_statement", {})
        rev_list = is_.get("revenue", [])
        op_list  = is_.get("operating_profit", [])
        years    = is_.get("years", [])
    return jsonify({
        "export_ratio":   None,
        "regions":        [],
        "customers":      [],
        "key_countries":  [],
        "production_base":[],
        "company_desc":   (dart_co or {}).get("description", co_entry.get("description", "")),
        "sector":         sector,
        "fin_years":      years,
        "fin_revenue":    rev_list,
        "fin_op_profit":  op_list,
        "_source":        "partial",
    })



# ── 섹터 테마 (업종별 주요 동향·촉매·리스크) ─────────────────
SECTOR_THEMES = {
    "반도체": {
        "icon": "💾",
        "theme": "AI 메모리 수퍼사이클",
        "desc": "생성형 AI 인프라 투자 급증으로 HBM·DDR5 수요가 구조적으로 확대되고 있습니다.",
        "catalysts": [
            "NVIDIA·AMD AI GPU 출하 확대 → HBM3E 공급 부족 지속",
            "DDR5 서버 DRAM 전환 가속화 (2024년 50% 돌파)",
            "미국 CHIPS Act 보조금 — 국내 기업 미국 투자 본격화",
        ],
        "risks": [
            "중국 창신메모리(CXMT) 저가 DRAM 공급 증가",
            "스마트폰·PC 교체 사이클 둔화",
            "미중 수출 규제 추가 확대 가능성",
        ],
    },
    "반도체/전자": {
        "icon": "💾",
        "theme": "AI 반도체·가전 투트랙",
        "desc": "메모리 AI 수요와 가전·디스플레이 회복이 동시 진행되고 있습니다.",
        "catalysts": [
            "HBM3E 공급 확대 및 엔비디아 공급망 진입",
            "스마트폰 AI 온디바이스 기능 탑재 → DRAM 용량 확대",
            "OLED TV·폴더블 폰 프리미엄 가전 수요",
        ],
        "risks": [
            "파운드리 TSMC 대비 기술 격차 지속",
            "중국 메모리 업체 저가 공세",
            "원/달러 환율 변동성",
        ],
    },
    "자동차": {
        "icon": "🚗",
        "theme": "EV 전환 + 친환경차 세액공제",
        "desc": "전기차로의 전환 속도와 IRA 세액공제 혜택이 글로벌 완성차 경쟁 구도를 재편하고 있습니다.",
        "catalysts": [
            "IRA(미국 인플레이션 감축법) 보조금 — 미국산 EV 수혜",
            "현대·기아 미국 조지아 공장 가동 → 현지 생산 확대",
            "하이브리드 수요 급증 — 중간 단계 수익성 개선",
        ],
        "risks": [
            "글로벌 EV 수요 성장 둔화 (가격 저항)",
            "중국 BYD 등 저가 EV 브랜드 글로벌 진출",
            "원자재(리튬·니켈) 가격 불확실성",
        ],
    },
    "자동차부품": {
        "icon": "⚙️",
        "theme": "전동화·ADAS 부품 전환",
        "desc": "ICE에서 EV로의 전환이 부품 구성을 바꾸고, ADAS·전장 비중이 확대되고 있습니다.",
        "catalysts": [
            "현대차그룹 EV 생산 확대 → 전용 모듈·부품 수요",
            "ADAS·자율주행 센서·제어기 탑재 의무화 확대",
            "인도·동남아 신흥 시장 완성차 수요 성장",
        ],
        "risks": [
            "글로벌 완성차 생산량 조정 시 동반 영향",
            "중국 로컬 부품업체 가격 경쟁 심화",
            "전동화 전환기 레거시 부품 수익성 하락",
        ],
    },
    "전지/배터리": {
        "icon": "🔋",
        "theme": "EV 배터리 + ESS 확대",
        "desc": "EV 수요 조정에도 ESS·유럽 수요가 성장 엔진으로 부각되고 있습니다.",
        "catalysts": [
            "유럽 배터리 현지화 규제 → 헝가리·폴란드 공장 확장",
            "ESS(에너지저장장치) 시장 2030년까지 CAGR 30%+ 전망",
            "원통형 46파이 배터리 플랫폼 전환 (테슬라·리비안 채택)",
        ],
        "risks": [
            "EV 수요 성장 속도 기대치 하회",
            "리튬·코발트·니켈 원자재 가격 변동성",
            "중국 CATL·BYD의 유럽 시장 진출 가속화",
        ],
    },
    "의약": {
        "icon": "💊",
        "theme": "바이오시밀러 글로벌 확대",
        "desc": "대형 바이오의약품 특허 만료와 바이오시밀러 처방 의무화가 국내 기업에 기회를 제공합니다.",
        "catalysts": [
            "글로벌 블록버스터 바이오 특허 만료 — 시밀러 수혜",
            "미국 Inflation Reduction Act — 정부 바이오시밀러 구매 의무화",
            "AI 신약개발(AI-Drug Discovery) 플랫폼 상용화",
        ],
        "risks": [
            "FDA·EMA 허가 지연 및 임상 실패 리스크",
            "오리지널 제약사의 리베이트·가격 인하 방어 전략",
            "바이오시밀러 가격 경쟁 심화",
        ],
    },
    "화학": {
        "icon": "⚗️",
        "theme": "배터리 소재 전환 + 정기보수",
        "desc": "전통 석유화학 수익성 압박 속에서 EV용 배터리 소재 전환이 핵심 전략입니다.",
        "catalysts": [
            "EV 배터리 소재(양극재·전해질·분리막) 증설 완료",
            "유럽 배터리 현지화 → 소재 장기계약 확대",
            "정기보수 종료 후 범용 화학 가동률 회복",
        ],
        "risks": [
            "중국 화학 업체 공급과잉 지속",
            "납사·원유 가격 상승 시 원가 압박",
            "배터리 소재 판가 하락 (리튬 가격 연동)",
        ],
    },
    "철강": {
        "icon": "🏗️",
        "theme": "그린스틸 전환 + 중국 공급과잉",
        "desc": "탄소중립 그린스틸 투자와 중국발 공급과잉이 동시에 진행되고 있습니다.",
        "catalysts": [
            "EU CBAM(탄소국경조정제도) 시행 → 저탄소 철강 프리미엄",
            "조선·건설 발주 회복 → 후판·형강 수요 증가",
            "리튬·니켈 배터리 소재 신사업 성과",
        ],
        "risks": [
            "중국 부동산 침체 → 내수 과잉분 수출 증가",
            "국내 건설경기 침체 — 국내 수요 둔화",
            "원료탄·철광석 가격 변동",
        ],
    },
    "발전": {
        "icon": "⚡",
        "theme": "원전 르네상스 + SMR",
        "desc": "에너지 안보와 탄소중립 두 가지 요구가 원전·재생에너지 수요를 끌어올리고 있습니다.",
        "catalysts": [
            "체코·폴란드 등 유럽 원전 수출 수주 가시화",
            "SMR(소형모듈원전) 글로벌 개발 가속 — 국내 기업 수혜",
            "중동 가스복합발전·담수 플랜트 수주 증가",
        ],
        "risks": [
            "원전 프로젝트 장기화에 따른 수주·매출 인식 지연",
            "국내 에너지 정책 변화 리스크",
            "신재생에너지 단가 하락 — 가스발전 경쟁력 약화",
        ],
    },
    "IT서비스": {
        "icon": "💻",
        "theme": "AI 플랫폼 경쟁·클라우드 확대",
        "desc": "생성형 AI 서비스 도입과 클라우드 전환이 IT 서비스 업체의 성장을 이끌고 있습니다.",
        "catalysts": [
            "기업 AI 전환(AI Transformation) 수요 — SI·클라우드 수혜",
            "공공 클라우드 전환 가속 (망 분리 규제 완화)",
            "AI 에이전트·RPA 도입 확대",
        ],
        "risks": [
            "빅테크(MS·구글·아마존) 플랫폼 의존도 심화",
            "IT 인력 확보 경쟁 — 인건비 상승",
            "경기 침체 시 기업 IT 투자 축소",
        ],
    },
    "인터넷/IT서비스": {
        "icon": "🌐",
        "theme": "AI 서비스 수익화 + 일본 재도약",
        "desc": "포털·커머스·AI 서비스 수익화와 일본 등 해외 플랫폼 성장이 핵심 과제입니다.",
        "catalysts": [
            "생성형 AI 서비스(검색·큐레이션) 수익화 본격화",
            "일본 라인야후·픽코마 등 해외 플랫폼 성장",
            "커머스 광고·구독 ARPU 개선",
        ],
        "risks": [
            "글로벌 빅테크(Google·TikTok) 국내 광고 점유율 잠식",
            "카카오 규제 리스크 및 계열사 거버넌스",
            "광고 경기 둔화 시 플랫폼 매출 직격",
        ],
    },
    "통신": {
        "icon": "📡",
        "theme": "5G 수익화 + AI·미디어 융합",
        "desc": "5G 인프라 투자 효율화와 AI·미디어 신사업으로 성장 동력을 모색하고 있습니다.",
        "catalysts": [
            "5G B2B(스마트팩토리·자율주행) 기업 수요 확대",
            "AI 데이터센터 수요 → 통신망 트래픽·클라우드 연계",
            "OTT·미디어 구독 수익 확대",
        ],
        "risks": [
            "ARPU 정체 — 요금 인상 규제 지속",
            "네트워크 인프라 투자비 부담",
            "MVN0·알뜰폰 시장 성장 → 수익성 압박",
        ],
    },
    "은행": {
        "icon": "🏦",
        "theme": "고금리 수혜 + 주주환원 확대",
        "desc": "순이자마진 확대와 밸류업 정책이 은행주의 재평가 기회를 만들고 있습니다.",
        "catalysts": [
            "금리 고원 장기화 → NIM(순이자마진) 유지",
            "정부 밸류업 프로그램 → 주주환원(배당·자사주) 확대",
            "기업 대출·PF 회복 시 이자이익 개선",
        ],
        "risks": [
            "부동산 PF 부실 우려 → 충당금 적립 증가",
            "기준금리 인하 시 NIM 하락",
            "가계부채 규제 강화 → 대출 성장 제한",
        ],
    },
    "방산": {
        "icon": "🛡️",
        "theme": "K-방산 수출 슈퍼사이클",
        "desc": "유럽·중동·동남아 방산 수요가 폭발적으로 증가하며 국내 방산기업의 수출 황금기가 열리고 있습니다.",
        "catalysts": [
            "폴란드 K9·K239·FA50 등 대규모 수출 계약 집행 중",
            "NATO 회원국 국방비 GDP 2% 목표 상향",
            "호주 레드백(IFV) 수주 및 인도·중동 시장 개척",
        ],
        "risks": [
            "러시아-우크라이나 전쟁 종전 시 유럽 수요 위축 가능성",
            "수출 계약 집행 지연 및 환율 리스크",
            "미국·유럽 방산업체와의 기술 격차",
        ],
    },
}

# ── 종목 뉴스 fetch ─────────────────────────────────────────
_HK_HDR = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36"),
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": "https://markets.hankyung.com/",
}


def _fetch_hankyung_consensus(code: str) -> dict:
    """한경 컨센서스 페이지 스크래핑: 요약 + 최신 리포트."""
    from bs4 import BeautifulSoup
    import re as _re

    try:
        url = f"https://markets.hankyung.com/stock/{code}/consensus"
        r = requests.get(url, headers=_HK_HDR, timeout=12)
        if r.status_code != 200:
            return {}
        soup = BeautifulSoup(r.content, "lxml")

        # ── 요약 테이블 파싱 (table-list) ──────────────────────
        tbl = soup.find("table", class_="table-list")
        opinion = cur_price = target_price = per = eps = exp_eps = None
        if tbl:
            rows = tbl.find_all("tr")
            for row in rows:
                th = (row.find("th") or row.find("td"))
                tds = row.find_all("td")
                label = th.get_text(" ", strip=True) if th else ""
                val   = tds[-1].get_text(" ", strip=True) if tds else ""

                # 투자의견
                opinion_tag = tbl.find(string=_re.compile(r'^(매수|보유|매도|강력매수|강력매도)$'))
                if opinion_tag and not opinion:
                    opinion = opinion_tag.strip()

        # table-list 텍스트에서 직접 추출
        if tbl:
            txt = tbl.get_text("\n", strip=True)
            if not opinion:
                m = _re.search(r'(강력매수|매수|보유|매도|강력매도)', txt)
                opinion = m.group(1) if m else None

            # 종가 / 목표가
            lines = [l.strip() for l in txt.split("\n") if l.strip()]
            for i, line in enumerate(lines):
                if "종가" in line and i + 1 < len(lines):
                    m = _re.search(r'([\d,]+)원', "\n".join(lines[i:i+3]))
                    if m: cur_price = int(m.group(1).replace(",", ""))
                if "목표가" in line and i + 1 < len(lines):
                    m = _re.search(r'([\d,]+)원', "\n".join(lines[i:i+3]))
                    if m: target_price = int(m.group(1).replace(",", ""))
                if "PER" in line and i + 1 < len(lines):
                    m = _re.search(r'([\d.]+)', lines[i+1])
                    if m: per = float(m.group(1))
                if line == "EPS" and i + 2 < len(lines):
                    m = _re.search(r'([\d,.]+)', lines[i+2])
                    if m: eps = float(m.group(1).replace(",", ""))
                if "예상" in line and "EPS" in line and i + 1 < len(lines):
                    m = _re.search(r'([\d,.]+)', lines[i+1])
                    if m: exp_eps = float(m.group(1).replace(",", ""))

        # ── NUXT 페이로드에서 추가 목표주가 데이터 ──────────────
        nuxt_targets = []   # [(brokerage, analyst, target_price, date)]
        for s in soup.find_all("script"):
            t = s.get_text()
            if "__NUXT__" not in t:
                continue
            # 패턴: "증권코드","증권사명",target,"날짜",cur,"매수/보유/매도"
            # 또는 individual report target patterns
            # 목표주가 범위 (최솟값, 평균, 최댓값) 추출
            m_range = _re.search(
                r'(\d{4,6}),(\d{4,6}),"20\d{6}","20\d{2}-\d{2}-\d{2}",',
                t)
            if m_range:
                lo, hi = int(m_range.group(1)), int(m_range.group(2))
                # 값이 합리적인 주가 범위(5만~200만)이면 사용
                if 50_000 < lo < 2_000_000 and 50_000 < hi < 2_000_000:
                    if not target_price or (lo > target_price and hi > target_price):
                        # NUXT의 lo/hi가 더 신뢰성 있을 때만 override
                        pass  # target_price 유지 (table-list 우선)
            break

        # ── 최신 리포트 파싱 (swiper-slide) ─────────────────────
        reports = []
        slides = soup.find_all("div", class_="swiper-slide")
        for slide in slides:
            item = slide.find("div", class_="item")
            if not item:
                continue
            by_div = item.find("div", class_="report-by")
            if not by_div:
                continue
            by_text = by_div.get_text("|", strip=True)   # "애널리스트|증권사|날짜"
            parts   = [p.strip() for p in by_text.split("|") if p.strip()]
            # 제목: item 전체에서 by_div 텍스트 빼고 남은 것
            full_txt = item.get_text(" ", strip=True)
            title = full_txt.replace(by_text.replace("|", " "), "").strip()
            # 앞부분 회사명 제거 (예: "삼성전자(005930) ")
            title = _re.sub(r'^[가-힣A-Za-z\d\s\(\)]+\)\s*', '', title).strip() or title

            analyst   = parts[0] if len(parts) > 0 else ""
            brokerage = parts[1] if len(parts) > 1 else ""
            date      = parts[2] if len(parts) > 2 else ""

            reports.append({
                "title":     title,
                "analyst":   analyst,
                "brokerage": brokerage,
                "date":      date,
            })

        # 상승여력 계산
        upside = None
        if cur_price and target_price and cur_price > 0:
            upside = round((target_price - cur_price) / cur_price * 100, 1)

        return {
            "opinion":      opinion,
            "cur_price":    cur_price,
            "target_price": target_price,
            "per":          per,
            "eps":          eps,
            "exp_eps":      exp_eps,
            "upside":       upside,
            "reports":      reports,
            "_source":      "hankyung",
        }
    except Exception as e:
        app.logger.warning(f"한경 컨센서스 스크래핑 실패 {code}: {e}")
        return {}


def _fetch_hankyung_news(max_items: int = 8) -> list:
    """한경 증권 RSS 뉴스."""
    import xml.etree.ElementTree as _ET
    from email.utils import parsedate_to_datetime as _pdt
    try:
        r = requests.get("https://www.hankyung.com/feed/finance",
                         headers=_HK_HDR, timeout=8)
        if r.status_code != 200:
            return []
        root = _ET.fromstring(r.content)
        result = []
        for it in root.findall(".//item")[:max_items]:
            title = (it.findtext("title") or "").strip()
            link  = (it.findtext("link")  or "").strip()
            pub   = (it.findtext("pubDate") or "").strip()
            try:
                dt_str = _pdt(pub).strftime("%Y.%m.%d %H:%M")
            except Exception:
                dt_str = pub[:16]
            if title:
                result.append({"title": title, "source": "한국경제",
                               "dt": dt_str, "url": link})
        return result
    except Exception:
        return []


def _fetch_rss(url: str, max_items: int = 6, source_override: str = "") -> list:
    """RSS 피드 URL을 받아 뉴스 아이템 목록 반환."""
    import xml.etree.ElementTree as ET
    from email.utils import parsedate_to_datetime
    _hdr = {"User-Agent": "Mozilla/5.0 (compatible; RSS reader/1.0)"}
    try:
        r = requests.get(url, headers=_hdr, timeout=8)
        if r.status_code != 200:
            return []
        root = ET.fromstring(r.content)
        items = root.findall(".//item")
        result = []
        for it in items[:max_items]:
            title = (it.findtext("title") or "").strip()
            link  = (it.findtext("link")  or "").strip()
            pub   = (it.findtext("pubDate") or "").strip()
            src_el = it.find("source")
            source = source_override or (src_el.text.strip() if src_el is not None and src_el.text else "")
            # pubDate 파싱
            try:
                dt = parsedate_to_datetime(pub)
                dt_str = dt.strftime("%Y.%m.%d %H:%M")
            except Exception:
                dt_str = pub[:16]
            if title and link:
                result.append({"title": title, "source": source, "dt": dt_str, "url": link})
        return result
    except Exception:
        return []


def _fetch_foreign_news(company_name: str = "", stock_code: str = "",
                        max_items: int = 8) -> list:
    """Bloomberg + Google News RSS로 해외 뉴스 수집."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # 종목별 검색어 (영문 회사명 또는 코드 기반)
    _KR_EN = {
        "005930": "Samsung Electronics", "000660": "SK Hynix",
        "035420": "Naver Korea", "035720": "Kakao Korea",
        "066570": "LG Electronics", "005380": "Hyundai Motor",
        "000270": "Kia Motors", "051910": "LG Chem",
        "068270": "Celltrion", "006400": "Samsung SDI",
    }
    en_name = _KR_EN.get(stock_code, company_name)

    # 일반 마켓 피드 (섹터 공통)
    market_feeds = [
        ("Bloomberg",  "https://feeds.bloomberg.com/markets/news.rss", 4),
        ("Google News","https://news.google.com/rss/search?q=korea+stock+market"
                       "&hl=en&gl=US&ceid=US:en", 4),
    ]
    # 종목별 피드
    stock_feeds = []
    if en_name:
        q = requests.utils.quote(f"{en_name} stock")
        stock_feeds.append(
            ("Google News",
             f"https://news.google.com/rss/search?q={q}&hl=en&gl=US&ceid=US:en",
             6)
        )

    seen, stock_items, market_items = set(), [], []

    def _fetch_one(name, url, n, is_stock=False):
        items = _fetch_rss(url, max_items=n,
                           source_override=name if "bloomberg" in url.lower() else "")
        return items, is_stock

    all_feeds = [(name, url, n, True)  for name, url, n in stock_feeds] + \
                [(name, url, n, False) for name, url, n in market_feeds]

    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = {ex.submit(_fetch_one, name, url, n, is_s): name
                   for name, url, n, is_s in all_feeds}
        for fut in as_completed(futures):
            items, is_s = fut.result()
            bucket = stock_items if is_s else market_items
            for item in (items or []):
                key = item["title"][:60]
                if key not in seen:
                    seen.add(key)
                    bucket.append(item)

    # 종목 관련 뉴스 우선, 나머지는 날짜순 보완
    stock_items.sort(key=lambda x: x.get("dt",""), reverse=True)
    market_items.sort(key=lambda x: x.get("dt",""), reverse=True)
    result = stock_items + [i for i in market_items if i["title"][:60] not in {s["title"][:60] for s in stock_items}]
    return result[:max_items]


def _fetch_stock_news(code: str, max_items: int = 8) -> list:
    """Naver 모바일 종목 뉴스 클러스터에서 최신 기사 목록 반환."""
    try:
        url = f"https://m.stock.naver.com/api/news/stock/{code}"
        _hdr = {
            "User-Agent": ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                           "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                           "Mobile/15E148 Safari/604.1"),
            "Referer": "https://m.stock.naver.com/",
        }
        r = requests.get(url, headers=_hdr,
                         params={"page": 1, "pageSize": max_items}, timeout=6)
        if r.status_code != 200:
            return []
        clusters = r.json()
        news = []
        for cluster in clusters:
            for item in (cluster.get("items") or []):
                dt_raw = item.get("datetime", "")   # "202605131348"
                try:
                    dt_str = f"{dt_raw[:4]}.{dt_raw[4:6]}.{dt_raw[6:8]} {dt_raw[8:10]}:{dt_raw[10:12]}"
                except Exception:
                    dt_str = dt_raw
                import html as _html
                news.append({
                    "title":  _html.unescape(item.get("title") or ""),
                    "source": item.get("officeName") or "",
                    "dt":     dt_str,
                    "url":    item.get("mobileNewsUrl") or "",
                    "body":   _html.unescape((item.get("body") or "")[:120]),
                })
                if len(news) >= max_items:
                    return news
        return news
    except Exception:
        return []


# ── 섹터 동향 캐시 ───────────────────────────────────────────
_sector_cache: dict = {}
_SECTOR_TTL = 3600 * 1   # 1시간


@app.route("/api/sector-trend/<code>")
def get_sector_trend(code):
    """섹터 동향: 업종 피어 목록 + 시총/PER/PBR 비교 + 섹터 테마."""
    from concurrent.futures import ThreadPoolExecutor

    now    = datetime.now()
    cached = _sector_cache.get(code)
    if cached and (now - cached["ts"]).total_seconds() < _SECTOR_TTL:
        return jsonify(cached["data"])

    # ── 1. 메인 기업 기본 정보 ───────────────────────────────
    co_entry = COMPANIES.get(code, {})
    dart_co  = get_dart_company(code) if DART_KEY else None
    sector   = co_entry.get("sector") or (dart_co or {}).get("sector") or "상장기업"
    name     = (dart_co or {}).get("name") or co_entry.get("name") or code

    # ── 2. Naver 동종업종 피어 (시총 순 최대 15개) ───────────
    peers = _fetch_naver_industry_peers(code)

    # ── 3. 메인 + 피어 실시간 가격·PER·PBR 병렬 조회 ────────
    all_codes = [code] + [p["code"] for p in peers[:14]]

    def _get_price(c):
        rt = _fetch_realtime_price(c)
        return c, rt

    price_map = {}
    with ThreadPoolExecutor(max_workers=min(len(all_codes), 8)) as ex:
        for c, rt in ex.map(_get_price, all_codes):
            price_map[c] = rt or {}

    # ── 4. 피어 데이터 정리 ──────────────────────────────────
    peer_map = {p["code"]: p for p in peers}
    items = []
    for c in all_codes:
        rt       = price_map.get(c, {})
        peer_inf = peer_map.get(c, {})
        corp_inf = _corp_by_code.get(c, {})

        raw_name = (peer_inf.get("name") or rt.get("name")
                    or corp_inf.get("name") or co_entry.get("name") or c)
        cname  = _clean_corp_name(raw_name)

        # 시가총액: Naver 실시간 > Naver 피어 > 0
        mcap = (rt.get("market_cap") or peer_inf.get("market_cap") or 0)

        items.append({
            "code":         c,
            "name":         cname,
            "is_main":      c == code,
            "market_cap":   mcap,
            "current_price":rt.get("current_price") or peer_inf.get("current_price") or 0,
            "change_pct":   rt.get("change_pct"),
            "per":          rt.get("per"),
            "pbr":          rt.get("pbr"),
            "roe":          rt.get("roe"),
            "eps":          rt.get("eps"),
        })

    # 시총 내림차순 정렬, 메인 기업은 맨 앞 유지
    main_item  = next((x for x in items if x["is_main"]), None)
    other_items= sorted([x for x in items if not x["is_main"]],
                        key=lambda x: -(x["market_cap"] or 0))
    items = ([main_item] if main_item else []) + other_items

    # ── 5. 메인 기업 시총 순위 ───────────────────────────────
    all_by_mcap = sorted(items, key=lambda x: -(x["market_cap"] or 0))
    mcap_rank   = next((i+1 for i, x in enumerate(all_by_mcap) if x["is_main"]), None)

    # ── 6. 섹터 평균 지표 ────────────────────────────────────
    def _avg(lst):
        vals = [v for v in lst if v is not None and v > 0]
        return round(sum(vals) / len(vals), 1) if vals else None

    sector_per  = _avg([x["per"]  for x in items])
    sector_pbr  = _avg([x["pbr"]  for x in items])
    sector_roe  = _avg([x["roe"]  for x in items if x["roe"]])
    total_mcap  = sum(x["market_cap"] or 0 for x in items)

    main_per = main_item["per"]  if main_item else None
    main_pbr = main_item["pbr"]  if main_item else None
    main_roe = main_item["roe"]  if main_item else None

    # ── 7. 섹터 테마 매핑 ────────────────────────────────────
    theme = SECTOR_THEMES.get(sector) or next(
        (v for k, v in SECTOR_THEMES.items() if k in sector), None
    )

    # ── 8. DART 재무 기반 추가 지표 (메인 기업) ──────────────
    fin_data = get_dart_financials(code) if DART_KEY else None
    main_fin = {}
    if fin_data:
        is_ = fin_data.get("income_statement", {})
        rev = is_.get("revenue", [])
        opl = is_.get("operating_profit", [])
        yrs = is_.get("years", [])
        if rev and opl:
            main_fin = {
                "revenue_latest":   rev[-1],
                "op_profit_latest": opl[-1],
                "op_margin": round(opl[-1] / rev[-1] * 100, 1) if rev[-1] else None,
                "years": yrs, "revenue": rev, "op_profit": opl,
            }

    # ── 9. 뉴스 + 한경 컨센서스 (병렬 수집) ─────────────────────
    with ThreadPoolExecutor(max_workers=4) as _ex:
        _kr_fut   = _ex.submit(_fetch_stock_news,      code, 8)
        _en_fut   = _ex.submit(_fetch_foreign_news,    name, code, 8)
        _con_fut  = _ex.submit(_fetch_hankyung_consensus, code)
        _hkn_fut  = _ex.submit(_fetch_hankyung_news,   8)
    news          = _kr_fut.result()
    news_foreign  = _en_fut.result()
    consensus     = _con_fut.result()
    news_hankyung = _hkn_fut.result()

    result = {
        "code":         code,
        "name":         name,
        "sector":       sector,
        "items":        items[:15],
        "mcap_rank":    mcap_rank,
        "peer_count":   len(items),
        "total_mcap":   total_mcap,
        "sector_per":   sector_per,
        "sector_pbr":   sector_pbr,
        "sector_roe":   sector_roe,
        "main_per":     main_per,
        "main_pbr":     main_pbr,
        "main_roe":     main_roe,
        "theme":        theme,
        "main_fin":     main_fin,
        "news":         news,
        "news_foreign": news_foreign,
        "news_hankyung": news_hankyung,
        "consensus":    consensus,
        "_source":      "dart+naver+rss+hankyung",
    }
    _sector_cache[code] = {"data": result, "ts": now}
    return jsonify(result)


@app.route("/api/ai-report/<code>")
def get_ai_report(code):
    if DART_KEY:
        dart_fin = get_dart_financials(code)
        if dart_fin:
            return jsonify(_analyze_dart(code, dart_fin))
    return jsonify(AI_REPORTS.get(code, AI_REPORTS["005930"]))


@app.route("/api/status")
def status():
    return jsonify({
        "dart_key_set":      bool(DART_KEY),
        "corps_loaded":      _corps_ready.is_set(),
        "corps_count":       len(_corp_list),
        "dart_cache":        len(_api_cache),
        "price_cache":       len(_price_cache),
        "shares_cache":      len(_shares_cache),
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(debug=False, host="0.0.0.0", port=port)
