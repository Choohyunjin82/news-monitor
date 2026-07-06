/**
 * /api/summarize — 기사 본문 크롤링 + Gemini 요약 (Vercel 서버리스 함수)
 *
 * 절차:
 *   1. 전달받은 기사 URL 전체(화면에 표시된 건수와 동일)에 대해 본문 수집 시도
 *   2. 본문 확인된 기사만 Gemini에 전달하여 사실 기반 요약 생성
 *   3. 본문 확인 실패한 기사는 요약에 포함하지 않고, 제목·매체·날짜만 별도 목록으로 반환
 *      (추론에 의한 요약을 방지하기 위해 본문 미확인 기사는 AI 처리 대상에서 제외)
 *   4. 본문 확인 건수가 0건이면 요약을 생성하지 않고 제목 목록만 반환
 *
 * 필요 환경변수: GEMINI_API_KEY
 *
 * 알려진 한계: 구글 뉴스 링크(news.google.com/rss/articles/...)는 자바스크립트로만
 * 원본 주소를 확인할 수 있는 구조로 파악되어(2026-07 확인), 서버 코드로는 본문 수집이
 * 대부분 불가능하다. 네이버 API 등 원본 링크가 직접 제공되는 기사만 본문 수집이 가능하다.
 */

const CRAWL_TIMEOUT_MS = 8000;
const MAX_CRAWL = 50;          // 화면 표시 상한(최대 50건)과 동일하게 전체 시도
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

/* ── 구글 뉴스 링크 토큰 디코딩 ─────────────────────────────────
   news.google.com/rss/articles/{토큰} 형태의 링크는 토큰 자체가
   원본 기사 주소를 인코딩한 데이터인 경우가 있다. base64 디코딩 후
   바이트 안에서 http(s) 문자열을 찾아 추출한다. 실패할 수 있음
   (구조가 다르거나 원본 URL이 그대로 담겨 있지 않은 경우). */
function decodeGoogleNewsToken(url) {
  const m = url.match(/\/rss\/articles\/([^/?]+)/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const buf = Buffer.from(b64, 'base64');
    const str = buf.toString('latin1');
    const found = str.match(/https?:\/\/[^\s"'<>\x00-\x1f]+/);
    return found ? found[0] : null;
  } catch (e) {
    return null;
  }
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
  const debug = { url, finalUrl: null, httpStatus: null, textLength: 0, note: '' };

  let targetUrl = url;
  const isGoogleNewsLink = url.includes('news.google.com/rss/articles/');
  if (isGoogleNewsLink) {
    const decoded = decodeGoogleNewsToken(url);
    debug.decodeAttempted = true;
    debug.decodedUrl = decoded;
    if (decoded) {
      targetUrl = decoded;
    } else {
      debug.note = '구글 링크 토큰 디코딩 실패 — 원본 주소를 찾지 못함';
      return { text: null, debug };
    }
  }

  let response = await fetchWithTimeout(targetUrl, CRAWL_TIMEOUT_MS);
  if (!response) {
    debug.note = '접속 실패 또는 타임아웃(8초 초과)';
    return { text: null, debug };
  }
  debug.httpStatus = response.status;
  debug.finalUrl = response.url;

  if (!response.ok) {
    debug.note = 'HTTP 오류 응답';
    return { text: null, debug };
  }

  let html = await response.text();

  /* 디코딩 없이 구글 페이지로 접속된 경우(위 디코딩 실패했으나 여기까지 온 경우는 없음, 방어 코드) */
  const isGoogleHost = response.url && response.url.includes('news.google.com');
  debug.isGoogleRedirectPage = isGoogleHost;
  if (isGoogleHost) {
    const redirectTarget = findRedirectTarget(html);
    debug.redirectTargetFound = !!redirectTarget;
    if (redirectTarget) {
      const second = await fetchWithTimeout(redirectTarget, CRAWL_TIMEOUT_MS);
      if (second && second.ok) {
        html = await second.text();
        debug.finalUrl = second.url;
        debug.httpStatus = second.status;
      } else {
        debug.note = '리디렉션 대상 재요청 실패';
      }
    } else {
      debug.note = '구글 리디렉션 페이지에서 실제 주소를 찾지 못함';
    }
  }

  const text = extractBody(html);
  debug.textLength = text.length;

  if (text.length < 200) {
    debug.note = debug.note || '본문 추출 길이 부족(200자 미만) — 페이월/봇 차단/추출 실패 중 하나로 추정';
    return { text: null, debug };
  }
  return { text, debug };
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
  const titleOnlyItems = [];
  const debugList = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      debugList.push(r.value.debug);
      if (r.value.text) {
        successItems.push({ ...target[i], body: r.value.text });
      } else {
        titleOnlyItems.push(target[i]);
      }
    } else {
      debugList.push({ url: target[i].url, note: '예외 발생: ' + String(r.reason) });
      titleOnlyItems.push(target[i]);
    }
  });
  const successCount = successItems.length;

  /* 본문 확인된 기사가 없으면 요약 생성 없이 제목 목록만 반환 */
  if (successCount === 0) {
    return res.status(200).json({
      ok: true,
      totalCount,
      successCount: 0,
      summary: null,
      sources: [],
      titleOnly: titleOnlyItems.map(a => ({ title: a.title, source: a.source, date: a.date, url: a.url })),
      debug: debugList,
    });
  }

  const bodyBlock = successItems
    .map((a, i) => (i + 1) + '. [' + (a.source || '') + ' / ' + (a.date || '') + '] ' + a.title + '\n' + a.body)
    .join('\n\n');

  const prompt =
    '아래는 "' + subject + '" 관련 ' + (period || '') + ' 기간의 기사 본문입니다.\n\n' +
    '요약 원칙:\n' +
    '- 아래 제공된 기사 본문에 실제로 보도된 사실만 사용할 것\n' +
    '- 여기 없는 기사나 일반 지식으로 내용을 추측하거나 창작하지 말 것\n' +
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
      titleOnly: titleOnlyItems.map(a => ({ title: a.title, source: a.source, date: a.date, url: a.url })),
      debug: debugList,
    });

  } catch (err) {
    console.error('요약 오류:', err);
    return res.status(500).json({ error: '서버 오류: ' + err.message });
  }
}
