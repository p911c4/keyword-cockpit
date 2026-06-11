/**
 * KEYWORD COCKPIT — 프록시 서버 v2.2
 * Node.js 내장 모듈만 사용 (외부 패키지 불필요)
 *
 * 설정: .env 파일에 API 키 입력
 * 실행: node server.js
 * 접속: http://localhost:3000
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

// ── .env 파일 로드 (외부 패키지 없이 직접 파싱) ──────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('  ✗ .env 파일이 없습니다. .env 파일을 생성하고 API 키를 입력하세요.');
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
}

// 로컬: .env 파일 로드 / Railway: 환경변수 자동 주입
if (fs.existsSync(path.join(__dirname, '.env'))) {
  loadEnv();
  console.log('  [로컬 모드] .env 파일 로드됨');
} else {
  console.log('  [Railway 모드] 환경변수 사용');
}

const PORT          = parseInt(process.env.PORT) || 3000;
const CUSTOMER_ID   = process.env.NAVER_CUSTOMER_ID;
const API_KEY       = process.env.NAVER_API_KEY;
const SECRET_KEY    = process.env.NAVER_SECRET_KEY;
const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// 키 유효성 확인
if (!CUSTOMER_ID || !API_KEY || !SECRET_KEY ||
    CUSTOMER_ID.includes('여기에') || API_KEY.includes('여기에') || SECRET_KEY.includes('여기에')) {
  console.error('');
  console.error('  ✗ API 키가 설정되지 않았습니다.');
  console.error('  로컬: .env 파일에 키를 입력하세요.');
  console.error('  Railway: Variables 탭에서 환경변수를 설정하세요.');
  console.error('');
  process.exit(1);
}

// ── MIME types ────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── HMAC-SHA256 ───────────────────────────────────────
function hmacSHA256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

// ── HTTPS GET (리다이렉트 자동 추적, 최대 5회) ────────
function httpsGet(options, ts, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));
  const apiReq = https.request(options, apiRes => {
    // 3xx 리다이렉트 처리
    if ([301,302,303,307,308].includes(apiRes.statusCode) && apiRes.headers.location) {
      const loc = apiRes.headers.location;
      console.log(`  [redirect ${apiRes.statusCode}] → ${loc}`);
      // 응답 body 소비 (필수)
      apiRes.resume();
      const newUrl  = new URL(loc, `https://${options.hostname}`);
      const newOpts = Object.assign({}, options, {
        hostname: newUrl.hostname,
        path:     newUrl.pathname + newUrl.search,
      });
      return httpsGet(newOpts, ts, redirectCount + 1, callback);
    }
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => callback(null, apiRes.statusCode, data));
  });
  apiReq.on('error', callback);
  apiReq.end();
}

// ── Helper ────────────────────────────────────────────
function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
  });
  res.end(JSON.stringify(obj));
}

// ── 뉴카 블로그 포스팅 (RSS + Open API 조합) ──────────
// /api/myposts?query=키워드
function proxyMyBlog(req, res) {
  const parsed = url.parse(req.url, true);
  const query  = parsed.query.query || '';
  const qLower = query.toLowerCase();

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return sendJSON(res, 500, { error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수를 설정하세요' });
  }

  const collected = [];
  const seenLinks = new Set();

  // 결과 합치기 헬퍼
  function addItem(title, link, description) {
    const cleanLink = (link || '').split('?')[0];
    if (!cleanLink || seenLinks.has(cleanLink)) return;
    seenLinks.add(cleanLink);
    collected.push({ title, link, description });
  }

  // ── 1단계: RSS에서 최근 글 검색 ──
  function fetchRSS(cb) {
    const options = {
      hostname: 'rss.blog.naver.com',
      path:     '/p911c4.xml',
      method:   'GET',
      headers:  { 'User-Agent': 'Mozilla/5.0' }
    };
    httpsGet(options, null, 0, (err, statusCode, data) => {
      if (err || !data) { console.log('  [RSS] 실패'); return cb(); }
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(data)) !== null) {
        const block = match[1];
        const getTag = (tag) => {
          const m = block.match(new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>|<' + tag + '[^>]*>([^<]*)<\\/' + tag + '>'));
          return m ? (m[1] || m[2] || '').trim() : '';
        };
        const title = getTag('title');
        const link  = getTag('link') || (block.match(/<link>(.*?)<\/link>/) || [])[1] || '';
        const desc  = getTag('description');
        const text  = (title + ' ' + desc).toLowerCase();
        // 키워드 포함 여부 (공백 제거 비교)
        if (title && text.replace(/\s/g,'').includes(qLower.replace(/\s/g,''))) {
          addItem(title, link, desc);
        }
      }
      console.log('  [RSS] 매칭: ' + collected.length + '개');
      cb();
    });
  }

  // ── 2단계: Open API 검색 결과에서 p911c4 필터 ──
  function fetchAPI(cb) {
    const apiPath = '/v1/search/blog.json?query=' + encodeURIComponent(query) + '&display=100&sort=sim';
    const options = {
      hostname: 'openapi.naver.com',
      path:     apiPath,
      method:   'GET',
      headers: {
        'X-Naver-Client-Id':     CLIENT_ID,
        'X-Naver-Client-Secret': CLIENT_SECRET,
      }
    };
    httpsGet(options, null, 0, (err, statusCode, data) => {
      if (err || !data) { console.log('  [API] 실패'); return cb(); }
      try {
        const json = JSON.parse(data);
        (json.items || []).forEach(item => {
          const link = (item.link || '').toLowerCase();
          const blog = (item.bloggerlink || '').toLowerCase();
          const name = (item.bloggername || '').toLowerCase();
          if (link.includes('p911c4') || blog.includes('p911c4') || name === '뉴카') {
            addItem(item.title, item.link, item.description);
          }
        });
        console.log('  [API] 누적 후 총: ' + collected.length + '개');
      } catch(e) {}
      cb();
    });
  }

  // 순차 실행 → 결과 반환
  fetchRSS(() => {
    fetchAPI(() => {
      sendJSON(res, 200, {
        items: collected.slice(0, 3),
        searchUrl: 'https://blog.naver.com/PostSearchList.naver?blogId=p911c4&searchText=' + encodeURIComponent(query)
      });
    });
  });
}

// ── 네이버 블로그 검색 API 프록시 ──────────────────────
// /api/blog?query=키워드&display=10
function proxyBlogSearch(req, res) {
  const parsed = url.parse(req.url, true);
  const query   = parsed.query.query || '';
  const display = parseInt(parsed.query.display) || 10;

  if (!query) return sendJSON(res, 400, { error: 'query 파라미터가 없습니다' });
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return sendJSON(res, 500, { error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수를 설정하세요' });
  }

  const apiPath = `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=${display}&sort=sim`;

  const options = {
    hostname: 'openapi.naver.com',
    path:     apiPath,
    method:   'GET',
    headers: {
      'X-Naver-Client-Id':     CLIENT_ID,
      'X-Naver-Client-Secret': CLIENT_SECRET,
    }
  };

  httpsGet(options, null, 0, (err, statusCode, data) => {
    if (err) {
      console.error('  블로그 API 오류:', err.message);
      return sendJSON(res, 502, { error: '블로그 검색 API 연결 실패: ' + err.message });
    }
    console.log('  [Blog API] status:', statusCode, '/ query:', query);
    if (!data || data.trim() === '') {
      return sendJSON(res, 502, { error: '블로그 API 빈 응답' });
    }
    try { JSON.parse(data); } catch(e) {
      return sendJSON(res, 502, { error: '블로그 API 응답 파싱 오류: ' + data.slice(0,100) });
    }
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
}

// ── Naver API 프록시 ──────────────────────────────────
// 브라우저는 /api/keyword 로 키워드만 전달
// 서버가 .env의 키로 서명해서 api.naver.com 호출
function proxyNaverAPI(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let params;
    try { params = JSON.parse(body); }
    catch(e) { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { keywords } = params;
    if (!keywords?.length) {
      return sendJSON(res, 400, { error: 'keywords 필드가 없습니다' });
    }

    const qs        = keywords.map(k => `hintKeywords=${encodeURIComponent(k)}`).join('&') + '&showDetail=1';
    const basePath  = '/keywordstool';          // 쿼리스트링 제외한 경로
    const fullPath  = `${basePath}?${qs}`;
    const ts        = Date.now().toString();
    // ★ 공식 서명 규칙: timestamp.METHOD.path (쿼리스트링 제외)
    const sig       = hmacSHA256(SECRET_KEY, `${ts}.GET.${basePath}`);

    const options = {
      hostname: 'api.naver.com',
      path:     fullPath,
      method:   'GET',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Timestamp':  ts,
        'X-API-KEY':    API_KEY,
        'X-Customer':   CUSTOMER_ID,
        'X-Signature':  sig,
      }
    };

    httpsGet(options, ts, 0, (err, statusCode, data) => {
      if (err) {
        console.error('  Naver API 오류:', err.message);
        return sendJSON(res, 502, { error: 'Naver API 연결 실패: ' + err.message });
      }
      console.log('  [Naver API] status:', statusCode);
      console.log('  [Naver API] body  :', data.slice(0, 300));

      if (!data || data.trim() === '') {
        return sendJSON(res, 502, { error: '네이버 API 빈 응답 — API 키를 확인하세요.' });
      }
      try { JSON.parse(data); } catch(e) {
        return sendJSON(res, 502, { error: '네이버 API 응답이 JSON이 아닙니다: ' + data.slice(0, 200) });
      }
      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
      });
      res.end(data);
    });
  });
}

// ── Static file server ────────────────────────────────
function serveStatic(req, res) {
  // URL에서 경로만 추출 (쿼리스트링 제거)
  const reqPath  = url.parse(req.url).pathname;

  const fileName = (!reqPath || reqPath === "/") ? "index.html" : reqPath.replace(/^\//, "");
  const filePath  = path.join(__dirname, fileName);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end("Forbidden"); return; }
  const ext      = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

// ── Main server ───────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  'http://localhost:' + PORT,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method === 'POST' && parsed.pathname === '/api/keyword') {
    return proxyNaverAPI(req, res);
  }

  if (req.method === 'GET' && parsed.pathname === '/api/blog') {
    return proxyBlogSearch(req, res);
  }

  if (req.method === 'GET' && parsed.pathname === '/api/myposts') {
    return proxyMyBlog(req, res);
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ██╗  ██╗███████╗██╗   ██╗██╗    ██╗ ██████╗ ██████╗ ██████╗ ');
  console.log('  ██║ ██╔╝██╔════╝╚██╗ ██╔╝██║    ██║██╔═══██╗██╔══██╗██╔══██╗');
  console.log('  █████╔╝ █████╗   ╚████╔╝ ██║ █╗ ██║██║   ██║██████╔╝██║  ██║');
  console.log('  ██╔═██╗ ██╔══╝    ╚██╔╝  ██║███╗██║██║   ██║██╔══██╗██║  ██║');
  console.log('  ██║  ██╗███████╗   ██║   ╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝');
  console.log('  ╚═╝  ╚═╝╚══════╝   ╚═╝    ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝ ');
  console.log('');
  console.log(`  COCKPIT SERVER ONLINE`);
  console.log(`  ✓ Customer ID  : ${CUSTOMER_ID}`);
  console.log(`  ✓ API Key      : ${API_KEY.slice(0,12)}...`);
  console.log(`  ✓ Secret Key   : ${SECRET_KEY.slice(0,8)}...`);
  console.log('');
  console.log(`  → 브라우저 접속: http://localhost:${PORT}`);
  console.log('  → 종료: Ctrl+C');
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`  ✗ 포트 ${PORT} 이미 사용 중. 다른 터미널에서 실행 중인지 확인하세요.`);
  } else {
    console.error('  ✗ 서버 오류:', err.message);
  }
  process.exit(1);
});
