/**
 * /api/rss — Google News RSS 프록시 (Vercel 서버리스 함수)
 *
 * 브라우저에서 Google News RSS를 직접 호출하면 CORS 정책에 막히므로,
 * 이 서버리스 함수가 중간에서 대신 호출하여 JSON으로 변환해 반환합니다.
 *
 * 파라미터:
 *   q    : 검색어 (예: "Skydio drone")
 *   from : 시작일 (YYYY-MM-DD)
 *   to   : 종료일 (YYYY-MM-DD)
 *
 * 반환:
 *   { articles: [ { title, source, date, daysAgo, url }, ... ] }
 */

export default async function handler(req, res) {
  // CORS 허용 (같은 도메인에서만 호출되나, 명시적으로 설정)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { q, from, to } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'q 파라미터가 필요합니다.' });
  }

  // Google News RSS URL 구성
  // hl=en-US: 영문 기사 우선 / ceid=US:en: 미국 기준
  const rssUrl =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(q) +
    '&hl=en-US&gl=US&ceid=US:en';

  try {
    const response = await fetch(rssUrl, {
      headers: {
        // Google이 봇 차단을 하는 경우를 위해 일반 브라우저처럼 보이게 설정
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'RSS 수집 실패: ' + response.status });
    }

    const xml = await response.text();

    // XML 파싱 — 정규식으로 <item> 블록 추출
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];

      // 제목
      const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                         block.match(/<title>([\s\S]*?)<\/title>/);
      const rawTitle = titleMatch ? titleMatch[1].trim() : '';

      // 원문 링크 (Google 리디렉션 URL → 실제 기사 URL 추출 시도)
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/) ||
                        block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      let url = linkMatch ? linkMatch[1].trim() : '';

      // 출처 (source 태그 또는 제목에서 " - 언론사명" 패턴 추출)
      const sourceTagMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      let source = sourceTagMatch ? sourceTagMatch[1].trim() : '';
      if (!source) {
        // Google News 제목 형식: "기사 제목 - 언론사명"
        const parts = rawTitle.split(' - ');
        if (parts.length > 1) source = parts[parts.length - 1].trim();
      }

      // 제목에서 " - 언론사명" 제거 (출처 중복 방지)
      const title = rawTitle.replace(/\s*-\s*[^-]+$/, '').trim() || rawTitle;

      // 발행일
      const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      let date = '';
      let daysAgo = 0;
      if (pubDateMatch) {
        const d = new Date(pubDateMatch[1].trim());
        if (!isNaN(d.getTime())) {
          date = d.toISOString().slice(0, 10);
          daysAgo = Math.floor((Date.now() - d.getTime()) / 86400000);
        }
      }

      if (!title || !url) continue;

      // 기간 필터 (from~to)
      if (from && date && date < from) continue;
      if (to   && date && date > to)   continue;

      items.push({ title, source, date, daysAgo, url });
    }

    // 최신순 정렬
    items.sort((a, b) => a.daysAgo - b.daysAgo);

    return res.status(200).json({ articles: items });

  } catch (err) {
    console.error('RSS 수집 오류:', err);
    return res.status(500).json({ error: '서버 오류: ' + err.message });
  }
}
