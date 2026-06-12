/**
 * /api/rss — Google News RSS 프록시 (Vercel 서버리스 함수)
 * 파라미터: q(검색어), from(YYYY-MM-DD), to(YYYY-MM-DD)
 * 반환: { articles: [ { title, source, date, daysAgo, url }, ... ] }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { q, from, to } = req.query;
  if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다.' });

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
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];

      /* 제목: CDATA 유무 모두 처리 */
      let title = '';
      const titleCdata = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
      const titlePlain = block.match(/<title>([\s\S]*?)<\/title>/);
      const rawTitle = titleCdata
        ? titleCdata[1].trim()
        : titlePlain
        ? titlePlain[1].trim()
        : '';

      /* 출처: Google News 제목 형식 "기사제목 - 언론사명" 에서 추출 */
      let source = '';
      const sourceTag = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      if (sourceTag) {
        source = sourceTag[1].trim();
      } else {
        const parts = rawTitle.split(' - ');
        if (parts.length > 1) source = parts[parts.length - 1].trim();
      }

      /* 제목에서 " - 언론사명" 제거 */
      title = source
        ? rawTitle.replace(new RegExp('\\s*-\\s*' + source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '').trim()
        : rawTitle;
      if (!title) title = rawTitle;

      /* URL */
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/) ||
                        block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const url = linkMatch ? linkMatch[1].trim() : '';

      /* 발행일 */
      const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      let date = '';
      let daysAgo = 0;
      if (pubDateMatch) {
        const d = new Date(pubDateMatch[1].trim());
        if (!isNaN(d.getTime())) {
          date = d.toISOString().slice(0, 10);
          daysAgo = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
        }
      }

      if (!title || !url) continue;

      /* 기간 필터 */
      if (from && date && date < from) continue;
      if (to   && date && date > to)   continue;

      items.push({ title, source, date, daysAgo, url });
    }

    /* 최신순 정렬 */
    items.sort((a, b) => a.daysAgo - b.daysAgo);

    return res.status(200).json({ articles: items });

  } catch (err) {
    console.error('RSS 수집 오류:', err);
    return res.status(500).json({ error: '서버 오류: ' + err.message });
  }
}
