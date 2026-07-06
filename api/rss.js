/**
 * /api/rss — 뉴스 수집 프록시 (Vercel 서버리스 함수)
 * 수집 경로: Google News RSS(영문판) + Google News RSS(국문판) + 네이버 뉴스 검색 API
 * 네이버 API 키(NAVER_CLIENT_ID/SECRET) 미설정 시 구글 두 경로만 사용
 *
 * 기간별 기사 수 상한 (병합 후 전체 기준):
 *   1일  → 5건
 *   5일  → 10건
 *   10일 → 15건
 *   직접 지정 / 기타 → 30건
 *
 * 정렬 우선순위: 신뢰 매체 가중치 → 발행일 최신순
 * 제외: 페이월 매체, 개인 블로그, PR 배포 매체, 자사 뉴스룸(발표 자료)
 * 중복 제거: 제목 앞 30자 기준 유사 기사 1건만 유지 (신뢰도 높은 쪽 우선)
 */

/* ── 신뢰 매체 가중치 (높을수록 우선) ─────────────────────── */
const TRUSTED = {
  // 1순위 — 통신사
  'ap':         100, 'associated press': 100,
  'yonhap':     100, 'afp':        100,
  // 2순위 — 주요 경제·기술 매체
  'cnbc':        90, 'bloomberg':   90, 'financial times':  90,
  'techcrunch':  90, 'the verge':   90, 'wired':            90,
  'bbc':         90, 'nhk world':   90,
  'wall street journal': 90, 'wsj': 90,
  // 3순위 — 전문 산업 매체
  'dronexl':     70, 'electrek':    70, 'fedscoop':         70,
  'dronelife':   70, 'dronedj':     70, 'tectonic defense': 70,
  'datacenterdynamics': 70, 'dcd':  70, 'airforce technology': 70,
  'defense post': 70, 'aviation week': 70,
  'manufacturing today': 70, 'just-auto': 70,
  'vir.com.vn':  70, 'engadget':    70,
  // 4순위 — 일반 매체 (기본값 50)
};

/* ── 차단 목록 ──────────────────────────────────────────────── */
const BLOCKED = [
  // 페이월 / 구독 필요 — 출처명 + 도메인 모두 차단
  'reuters', 'reuters.com',
  'wall street journal', 'wsj.com', 'wsj.org',
  'nytimes', 'new york times', 'nytimes.com',
  'ft.com', 'financial times',
  'economist', 'economist.com',
  'the information', 'theinformation.com',
  'barrons', 'barrons.com',
  'bloomberg', 'bloomberg.com',
  'washingtonpost', 'washington post', 'washingtonpost.com',
  'theatlantic', 'the atlantic', 'theatlantic.com',
  'wired.com',
  'nikkei', 'nikkei.com', 'asia.nikkei.com',
  'automotive news', 'autonews.com',
  'business insider', 'businessinsider.com',
  'premium.chosun.com',
  // PR 배포 / 자사 뉴스룸
  'prnewswire', 'businesswire', 'globenewswire', 'accesswire',
  'nvidianews.nvidia.com', 'ir.tesla.com',
  // 개인 블로그 / UGC 플랫폼
  'medium.com', 'blogspot', 'wordpress.com', 'substack.com',
  'tumblr', 'blogger.com', 'metaintro', 'mean.ceo',
];

/* ── 기간별 상한 ────────────────────────────────────────────── */
function getLimit(from, to) {
  if (!from || !to) return 30;
  const days = Math.round((new Date(to) - new Date(from)) / 86400000);
  if (days <= 1)  return 5;
  if (days <= 5)  return 10;
  if (days <= 10) return 15;
  return 30;
}

/* ── 매체 가중치 ────────────────────────────────────────────── */
function trustScore(source) {
  if (!source) return 50;
  const s = source.toLowerCase();
  for (const [key, score] of Object.entries(TRUSTED)) {
    if (s.includes(key)) return score;
  }
  return 50;
}

/* ── 차단 여부 ──────────────────────────────────────────────── */
function isBlocked(source, url) {
  const s = (source || '').toLowerCase();
  const u = (url    || '').toLowerCase();
  return BLOCKED.some(b => s.includes(b) || u.includes(b));
}

/* ── 자사 매체 자동 제외 ──────────────────────────────────────
   RSS의 <link>는 대부분 news.google.com 리다이렉트 주소이므로
   URL 도메인이 아닌 <source>(매체명) 텍스트와 검색 기업명을 비교한다.
   4자 미만 검색어는 오탐 위험이 높아 비교 대상에서 제외한다.        */
function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}
function isSelfSource(source, companyTerms) {
  const s = normalizeText(source);
  if (!s) return false;
  return companyTerms.some(term => {
    const t = normalizeText(term);
    return t.length >= 4 && s.includes(t);
  });
}

/* ── 중복 제거 키 (제목 앞 30자) ───────────────────────────── */
function dedupKey(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '').slice(0, 30);
}

/* ── 단일 RSS 에디션 fetch + 파싱 ──────────────────────────────── */
async function fetchEdition(q, hl, gl, ceid, from, to) {
  const rssUrl =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(q) +
    '&hl=' + hl + '&gl=' + gl + '&ceid=' + ceid;

  const response = await fetch(rssUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error('RSS 수집 실패: ' + response.status);

  const xml = await response.text();
  const raw = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    /* 제목 */
    const titleCdata = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
    const titlePlain = block.match(/<title>([\s\S]*?)<\/title>/);
    const rawTitle = titleCdata
      ? titleCdata[1].trim()
      : titlePlain ? titlePlain[1].trim() : '';

    /* 출처 */
    const sourceTag = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    let source = sourceTag ? sourceTag[1].trim() : '';
    if (!source) {
      const parts = rawTitle.split(' - ');
      if (parts.length > 1) source = parts[parts.length - 1].trim();
    }

    /* 제목 정제 */
    const title = source
      ? rawTitle.replace(new RegExp(
          '\\s*-\\s*' + source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
        ), '').trim()
      : rawTitle;

    /* URL */
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/) ||
                      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const url = linkMatch ? linkMatch[1].trim() : '';

    /* 발행일 */
    const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    let date = '', daysAgo = 0;
    if (pubMatch) {
      const d = new Date(pubMatch[1].trim());
      if (!isNaN(d.getTime())) {
        date = d.toISOString().slice(0, 10);
        daysAgo = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
      }
    }

    if (!title || !url) continue;

    /* 기간 필터 */
    if (from && date && date < from) continue;
    if (to   && date && date > to)   continue;

    raw.push({ title, source, date, daysAgo, url, score: trustScore(source) });
  }
  return raw;
}

/* ── HTML 태그/엔티티 제거 (네이버 API 응답용) ────────────────── */
function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
}
function domainFromUrl(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); }
  catch (e) { return ''; }
}

/* ── 네이버 뉴스 검색 API fetch ─────────────────────────────────
   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없으면
   조용히 빈 배열을 반환한다(구글 결과만으로 서비스 지속).
   네이버 API는 매체명을 별도로 제공하지 않아, 원문 링크의
   도메인을 출처로 사용한다 (신뢰 매체 가중치는 도메인 기준 매칭 안 됨). */
async function fetchNaver(q, from, to) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const url = 'https://openapi.naver.com/v1/search/news.json?query=' +
    encodeURIComponent(q) + '&display=30&sort=date';

  const response = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
  });
  if (!response.ok) throw new Error('네이버 API 실패: ' + response.status);

  const data = await response.json();
  const raw = [];
  for (const item of (data.items || [])) {
    const title = stripHtml(item.title);
    const articleUrl = item.originallink || item.link || '';
    const source = domainFromUrl(articleUrl) || domainFromUrl(item.link) || '';

    let date = '', daysAgo = 0;
    if (item.pubDate) {
      const d = new Date(item.pubDate);
      if (!isNaN(d.getTime())) {
        date = d.toISOString().slice(0, 10);
        daysAgo = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
      }
    }

    if (!title || !articleUrl) continue;
    if (from && date && date < from) continue;
    if (to   && date && date > to)   continue;

    raw.push({ title, source, date, daysAgo, url: articleUrl, score: trustScore(source) });
  }
  return raw;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { q, q2, from, to } = req.query;
  if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다.' });

  const limit = getLimit(from, to);
  const companyTerms = [q, q2].filter(Boolean);

  try {
    /* 영문판(Google) + 국문판(Google) + 네이버 병행 수집 */
    const results = await Promise.allSettled([
      fetchEdition(q, 'en-US', 'US', 'US:en', from, to),
      fetchEdition(q2 || q, 'ko', 'KR', 'KR:ko', from, to),
      fetchNaver(q2 || q, from, to),
    ]);

    let raw = [];
    results.forEach(r => { if (r.status === 'fulfilled') raw = raw.concat(r.value); });

    if (raw.length === 0 && results.every(r => r.status === 'rejected')) {
      return res.status(502).json({ error: 'RSS 수집 실패 (모든 경로 실패)' });
    }

    /* 차단 매체 + 자사 매체 필터 */
    raw = raw.filter(a => !isBlocked(a.source, a.url) && !isSelfSource(a.source, companyTerms));

    /* 중복 제거 — 동일 키 중 score 높은 것 유지 */
    const seen = new Map();
    for (const a of raw) {
      const key = dedupKey(a.title);
      if (!seen.has(key) || seen.get(key).score < a.score) {
        seen.set(key, a);
      }
    }

    /* 정렬: score 내림차순 → 최신순 */
    const sorted = [...seen.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.daysAgo - b.daysAgo;
    });

    /* 상한 적용 */
    const articles = sorted.slice(0, limit);

    return res.status(200).json({ articles, limit, total: sorted.length });

  } catch (err) {
    console.error('RSS 수집 오류:', err);
    return res.status(500).json({ error: '서버 오류: ' + err.message });
  }
}
