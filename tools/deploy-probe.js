/* 배포물 검증 도구(M6). 배포물이 아니다.
 *   NODE_PATH=$(npm root -g) node tools/deploy-probe.js
 *
 * GitHub Pages 는 저장소 이름 하위 경로(/image-text-swap/)로 서빙된다.
 * 워크플로가 추리는 것과 같은 파일만 임시 디렉터리에 복사해 그 하위 경로로 띄우고,
 * 업로드 → 편집 → 합성 → 다운로드 전 과정을 돌려 본다.
 * 절대경로가 하나라도 섞이면 여기서 깨진다.
 */
const {chromium} = require('playwright');
const http = require('http-server');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8940;
const BASE = '/image-text-swap';          // Pages 하위 경로 흉내
const PAYLOAD = ['index.html', '.nojekyll', 'css', 'js', 'fonts', 'vendor'];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};

/** PNG 헤더에서 크기를 읽는다. 유효한 PNG 인지도 함께 확인한다. */
function pngInfo(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ok = sig.every((b, i) => buf[i] === b);
  if (!ok) return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25],           // 6 = RGBA
    bytes: buf.length,
  };
}

(async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  const dir = path.join(site, BASE.slice(1));
  fs.mkdirSync(dir, {recursive: true});
  for (const p of PAYLOAD) {
    fs.cpSync(path.join(ROOT, p), path.join(dir, p), {recursive: true});
  }
  const size = (d) => fs.readdirSync(d, {withFileTypes: true}).reduce((s, e) => {
    const q = path.join(d, e.name);
    return s + (e.isDirectory() ? size(q) : fs.statSync(q).size);
  }, 0);
  console.log(`배포물 ${(size(dir) / 1024 / 1024).toFixed(1)} MB  →  ${BASE}/ 로 서빙\n`);

  const server = http.createServer({root: site, cache: -1});
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({acceptDownloads: true, viewport: {width: 1280, height: 900}});
  const page = await ctx.newPage();
  const errors = [];
  const missing = [];
  const transfer = [];      // 실제로 내려받은 양 — 저장소 크기보다 이쪽이 중요하다
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (r) => {
    if (r.status() >= 400) { missing.push(`${r.status()} ${r.url()}`); return; }
    try {
      const b = await r.body();
      transfer.push({url: r.url().replace(`http://127.0.0.1:${PORT}${BASE}/`, ''), bytes: b.length});
    } catch { /* 리다이렉트 등 본문 없는 응답 */ }
  });

  console.log('[전체 흐름]');
  await page.goto(`http://127.0.0.1:${PORT}${BASE}/index.html`);
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-simple.png'));
  await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
    null, {timeout: 300000});

  const st = await page.evaluate(() => ({
    blocks: window.__app.state.blocks.length,
    ocr: window.__app.state.blocks.filter((b) => b.originalText).length,
    fonts: window.__app.state.blocks.filter((b) => b.detectedFont).length,
  }));
  check('하위 경로에서 검출·OCR·판별이 모두 동작한다',
    st.blocks === 2 && st.ocr === 2 && st.fonts === 2,
    `블록 ${st.blocks} · OCR ${st.ocr} · 판별 ${st.fonts}`);

  await page.evaluate(async () => {
    const app = window.__app;
    app.selectBlock('b1');
    app.state.blocks.find((b) => b.id === 'b1').draft = '2028 합격을 위한 헌법\n정답은, 써니 뿐입니다.';
    app.saveBlock();
    await app.runCompose();
  });
  check('합성 결과가 생긴다', await page.evaluate(() => !!window.__app.state.result));
  check('다운로드 버튼이 열린다', await page.getAttribute('#downloadBtn', 'disabled') === null);

  console.log('\n[다운로드]');
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#downloadBtn'),
  ]);
  const file = await dl.path();
  const buf = fs.readFileSync(file);
  const info = pngInfo(buf);

  check('파일명이 원본 기준으로 붙는다',
    dl.suggestedFilename() === 'sample-simple-edited.png', dl.suggestedFilename());
  check('유효한 PNG 다', info !== null);
  if (info) {
    check('원본과 같은 크기다', info.width === 1140 && info.height === 184,
      `${info.width}x${info.height}`);
    check('알파 채널이 보존된다 (colorType 6)', info.colorType === 6, `colorType ${info.colorType}`);
    console.log(`       ${(info.bytes / 1024).toFixed(0)} KB`);
  }

  console.log('\n[최초 1회 전송량]');
  const total = transfer.reduce((s2, t) => s2 + t.bytes, 0);
  const top = transfer.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 6);
  for (const t of top) console.log(`       ${(t.bytes / 1024 / 1024).toFixed(2).padStart(6)} MB  ${t.url}`);
  console.log(`       ${'─'.repeat(9)}`);
  console.log(`       ${(total / 1024 / 1024).toFixed(2).padStart(6)} MB  합계 (${transfer.length}개 요청)`);

  console.log('\n[정적 자산]');
  check('404 응답이 없다', missing.length === 0, missing.slice(0, 3).join(' / '));
  check('콘솔 오류가 없다', errors.length === 0, errors.slice(0, 2).join(' / '));

  await browser.close();
  server.close();
  fs.rmSync(site, {recursive: true, force: true});
  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
