/**
 * /api/summarize — 기사 본문 크롤링 + Gemini 요약 (Vercel 서버리스 함수)
 *
 * 절차:
 *   1. 전달받은 기사 URL 목록에 각각 접속하여 본문 텍스트 추출 시도
 *   2. 추출 실패 건은 제외하고, 성공한 기사만으로 요약 진행
 *   3. 성공 건수가 2건 미만이면 요약을 생성하지 않고 실패 사유 반환
 *   4. 성공 기사 본문을 모아 Gemini API(gemini-2.5-flash, 무료 티어)에 전달
 *
 * 필요 환경변수: GEMINI_API_KEY
 */

const CRAWL_TIMEOUT_MS = 8000;
const MAX_CRAWL = 20;          // 상한 건수와 무관하게 요약용 크롤링은 최대 20건까지만 시도 (실행 시간 제어)
const MIN_SUCCESS = 2;         // 이 건수 미만이면 요약 생성하지 않음
const BODY_CHAR_LIMIT = 1500;  // 기사 1건당 본문 사용 길이 제한

function stripTags(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function extractBody(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const articleMatch = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const target = articleMatch ? articleMatch[1] : cleaned;

  const paragraphs = [...target.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripTags(m[1]));
  let text = paragraphs.join(' ').trim();

  if (text.length < 200) text = stripTags(target); // 문단 태그가 부실한 경우 전체 텍스트로 대체

  return text.slice(0, BODY_CHAR_LIMIT);
}

function findRedirectTarget(html) {
  const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["']\s*\d+\s*;\s*url=([^"'>]+)["']/i);
  if (meta) return meta[1];
  const canon = html.match(/data-n-au=["']([^"']+)["']/i); // 구글 뉴스 일부 페이지의 실제 링크 속성
  if (canon) return canon[1];
  return null;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timer);
    return response;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

async function crawlArticle(url) {
  let response = await fetchWithTimeout(url, CRAWL_TIMEOUT_MS);
  if (!response || !response.ok) return null;

  let html = await response.text();

  /* 구글 뉴스 리디렉션 페이지인 경우, 실제 기사 주소를 찾아 한 번 더 요청 */
  const isGoogleHost = response.url && response.url.includes('news.google.com');
  if (isGoogleHost) {
    const target = findRedirectTarget(html);
    if (target) {
      const second = await fetchWithTimeout(target, CRAWL_TIMEOUT_MS);
      if (second && second.ok) html = await second.text();
    }
  }

  const text = extractBody(html);
  return text.length >= 200 ? text : null; // 200자 미만은 추출 실패로 간주
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
  }

  const { subject, period, articles } = req.body || {};
  if (!Array.isArray(articles) || articles.length === 0) {
    return res.status(400).json({ error: 'articles 배열이 필요합니다.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  const target = articles.slice(0, MAX_CRAWL);
  const totalCount = articles.length;

  const results = await Promise.allSettled(target.map(a => crawlArticle(a.url)));
  const successItems = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      successItems.push({ ...target[i], body: r.value });
    }
  });
  const successCount = successItems.length;

  if (successCount < MIN_SUCCESS) {
    return res.status(200).json({
      ok: false,
      totalCount,
      successCount,
      reason: '본문 수집 성공 건수 부족',
    });
  }

  const bodyBlock = successItems
    .map((a, i) => (i + 1) + '. [' + (a.source || '') + ' / ' + (a.date || '') + '] ' + a.title + '\n' + a.body)
    .join('\n\n');

  const prompt =
    '아래는 "' + subject + '" 관련 ' + (period || '') + ' 기간의 기사 본문입니다.\n\n' +
    '요약 원칙:\n' +
    '- 기사에 실제로 보도된 사실만 사용하고, 추론·전망·창작은 배제할 것\n' +
    '- 확인되지 않은 내용은 언급하지 말 것\n' +
    '- 한국어로 간결하게, 핵심 위주로 정리할 것\n' +
    '- 가능하면 주제별로 묶어 정리할 것\n\n' +
    '기사 본문(' + successCount + '건):\n\n' + bodyBlock;

  try {
    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    if (!geminiRes.ok) {
      return res.status(502).json({ error: 'Gemini 호출 실패: ' + geminiRes.status });
    }

    const data = await geminiRes.json();
    const summary = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] ? data.candidates[0].content.parts[0].text : '';

    if (!summary) {
      return res.status(502).json({ error: '요약 결과가 비어 있습니다.' });
    }

    return res.status(200).json({
      ok: true,
      totalCount,
      successCount,
      summary,
      sources: successItems.map(a => ({ title: a.title, source: a.source, date: a.date, url: a.url })),
    });

  } catch (err) {
    console.error('요약 오류:', err);
    return res.status(500).json({ error: '서버 오류: ' + err.message });
  }
}
