/**
 * /api/rss — Google News RSS 프록시 (Vercel 서버리스 함수)
 *
 * 기간별 기사 수 상한:
 *   1일  → 5건
 *   5일  → 10건
 *   10일 → 15건
 *   직접 지정 / 기타 → 30건
 *
 * 정렬 우선순위: 신뢰 매체 가중치 → 발행일 최신순
 * 제외: 페이월 매체, 개인 블로그, PR 배포 매체, 자사 뉴스룸
 * 중복 제거: 제목 앞 30자 기준 유사 기사 1건만 유지
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

/* ── 중복 제거 키 (제목 앞 30자) ───────────────────────────── */
function dedupKey(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '').slice(0, 30);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { q, from, to } = req.query;
  if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다.' });

  const limit = getLimit(from, to);

  const rssUrl =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(q) +
    '&hl=en-US&gl=US&ceid=US:en';

  try {
    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'RSS 수집 실패: ' + response.status });
    }

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

      /* 차단 필터 */
      if (isBlocked(source, url)) continue;

      raw.push({ title, source, date, daysAgo, url, score: trustScore(source) });
    }

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
