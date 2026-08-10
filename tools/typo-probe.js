/* 타이포 계측(폰트·크기·자간·행간·정렬) 검증 도구. 배포물이 아니다.
 *   NODE_PATH=$(npm root -g) node tools/typo-probe.js
 *
 * 확인하려는 것
 *   1. 항목별 수치가 나오고, 총합이 가중 평균과 맞는다
 *   2. 계측값이 실제 합성 결과와 같다 (같은 layout 경로를 쓴다)
 *   3. 정렬이 문구 길이 변화에 흔들리지 않는다  ← 이번 수정의 핵심
 *   4. 패널이 화면에 뜨고 폰트를 바꾸면 다시 계산된다
 */
const {chromium} = require('playwright');
const http = require('http-server');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = 8944;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const server = http.createServer({root: ROOT, cache: -1});
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 980}});
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  for (const file of ['assets/sample-simple.png', 'assets/sample-complex.png']) {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.setInputFiles('#fileInput', path.join(ROOT, file));
    await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
      null, {timeout: 300000});

    const rows = await page.evaluate(() => window.__app.state.blocks.map((b) => {
      const m = Typo.measure(window.__app.state.imageData, b, window.__app.fontFor(b));
      if (!m) return null;
      return {
        id: b.id, align: m.align.value, text: (b.originalText || '').split('\n')[0].slice(0, 20),
        font: m.font.label, f: m.font.score, s: m.size.score, t: m.tracking.score,
        a: m.align.score, total: m.total, px: m.size.px, tp: m.tracking.pct,
        capped: m.tracking.capped,
        lead: m.leading ? `${m.leading.px}px ${m.leading.ratio.toFixed(2)}배 기본대비${m.leading.delta.toFixed(0)}%` : null,
      };
    }).filter(Boolean));

    console.log(`\n=== ${path.basename(file)}  ${rows.length}블록`);
    console.log('  블록  총합  폰트  크기  자간  정렬   크기px  자간%   정렬     문구');
    for (const r of rows) {
      const p = (v) => (v * 100).toFixed(0).padStart(4);
      console.log(`  ${r.id.padEnd(4)}${p(r.total)}%${p(r.f)} ${p(r.s)} ${p(r.t)}${r.capped ? '!' : ' '}${p(r.a)}`
        + `   ${r.px.toFixed(1).padStart(5)}  ${(r.tp >= 0 ? '+' : '') + r.tp.toFixed(1)}`.padEnd(10)
        + ` ${r.align.padEnd(7)} "${r.text}"`);
      if (r.lead) console.log(`        행간 ${r.lead}`);
    }

    const W = await page.evaluate(() => Typo.W);
    const bad = rows.filter((r) => Math.abs(
      r.total - (W.font * r.f + W.size * r.s + W.tracking * r.t + W.align * r.a)) > 1e-9);
    check('총합이 항목 가중 평균과 일치한다', bad.length === 0, `${rows.length}블록 중 ${bad.length}건 불일치`);
    check('모든 점수가 0~1 범위다',
      rows.every((r) => [r.f, r.s, r.t, r.a, r.total].every((v) => v >= 0 && v <= 1)));
  }

  // ---- 고해상도 헤드라인 (v1.6 에서 고친 검출) ----
  console.log('\n[고해상도 헤드라인 분리]');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-headline.png'));
  await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
    null, {timeout: 300000});
  const hl = await page.evaluate(() => window.__app.state.blocks.map((b) => ({
    id: b.id, n: b.lines.length, w: b.bbox.x1 - b.bbox.x0, h: b.bbox.y1 - b.bbox.y0,
    text: (b.originalText || '').replace(/\n/g, ' '),
  })));
  for (const x of hl) console.log(`  ${x.id.padEnd(3)} ${x.n}줄 ${x.w}x${x.h}  "${x.text}"`);

  // RLSA 거리가 픽셀 고정이라 큰 글자에서 낱말이 안 이어졌다. 파란 줄이
  // `지금 공단기로` / `넘어오면 전-직렬` / `50만원 할인!` 세 조각으로 갈렸었다.
  const blue = hl.filter((x) => x.text.includes('공단기로') || x.text.includes('할인'));
  check('파란 한 줄이 한 블록이다', blue.length === 1,
    blue.map((x) => `"${x.text}"`).join(' + ') || '못 찾음');
  check('낱말이 다 이어졌다',
    blue.length === 1 && /지금.*넘어오면.*할인/.test(blue[0].text),
    blue[0] ? blue[0].text : '—');

  // 크기가 다른 두 줄을 한 블록으로 묶으면 합성이 크기를 하나로 통일해 둘 다 망친다.
  check('크기가 다른 두 줄은 안 묶인다', hl.every((x) => x.n === 1),
    hl.map((x) => `${x.id}:${x.n}줄`).join(' '));
  check('보이는 줄 수(4)만큼 나온다', hl.length === 4, `${hl.length}블록`);

  // ---- 정렬 안정성: 이번 수정의 핵심 ----
  console.log('\n[정렬 안정성 — 문구 길이가 바뀌어도 자리가 안 흔들리는가]');
  const drift = await page.evaluate(() => {
    const {setFont, inkMetrics, fitTracking, layout, inkX, guessAlign} = Compose.util;
    const st = window.__app.state;
    const c = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
    const out = [];
    for (const b of st.blocks) {
      if (!b.originalText || b.lines.length !== 1) continue;
      const font = window.__app.fontFor(b);
      const L = layout(c, b, font);
      const box = L.boxes[0], bw = box.x1 - box.x0;
      const src = L.srcLines[0] || '';
      if (src.length < 4) continue;
      const track = fitTracking(c, font, src, L.size, bw);
      const at = (t, align) => {
        setFont(c, font, L.size, track);
        return inkX(align, box, inkMetrics(c, t)) - box.x0;
      };
      // 한 글자 지운 문구로 바꿔 본다 — 실제 편집이 하는 일이다.
      const shorter = src.slice(0, -1);
      const m = Typo.measure(st.imageData, b, font);
      out.push({
        id: b.id, align: L.align, reported: m ? m.align.drift : -1,
        now: +at(shorter, L.align).toFixed(1),
        ifCenter: +at(shorter, 'center').toFixed(1),
        old: +at(shorter, guessAlign({lines: b.lines, bbox: b.bbox, id: b.id})).toFixed(1),
      });
    }
    return out;
  });
  for (const d of drift.slice(0, 8)) {
    console.log(`  ${d.id.padEnd(4)} ${d.align.padEnd(7)} 지금 ${d.now.toFixed(1)}px`
      + `   (가운데 정렬이었다면 ${d.ifCenter.toFixed(1)}px)`);
  }
  // 왼쪽 정렬은 고정되어야 한다. 가운데 정렬은 밀리는 게 맞다 — 원본이 실제로
  // 가운데 정렬이면 길어진 문구는 양쪽으로 퍼져야 한다. 숨길 게 아니라 알려 줄 일이다.
  const lefts = drift.filter((d) => d.align === 'left');
  const centers = drift.filter((d) => d.align === 'center');
  check('왼쪽 정렬은 한 글자 지워도 안 움직인다',
    lefts.length > 0 && lefts.every((d) => Math.abs(d.now) < 0.01),
    `${lefts.length}블록 중 ${lefts.filter((d) => Math.abs(d.now) >= 0.01).length}건 이동`);
  check('예전처럼 전부 가운데였다면 밀렸다 (비교 기준)',
    drift.every((d) => Math.abs(d.ifCenter) > 0.01),
    `${drift.filter((d) => Math.abs(d.ifCenter) > 0.01).length}/${drift.length}블록이 밀림`);
  check('가운데 정렬 블록은 이동량을 계측해 알린다',
    centers.every((d) => d.reported >= 0.05),
    centers.map((d) => `${d.id} ${d.reported.toFixed(1)}px`).join(' ') || '가운데 블록 없음');

  // ---- OCR 교정 (v1.8) ----
  console.log('\n[한글↔라틴 교정 · 그림 걸러내기]');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-complex.png'));
  await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
    null, {timeout: 300000});
  const ocr = await page.evaluate(() => ({
    fixed: window.__app.state.blocks.flatMap((b) => (b.fixedWords || []).map((f) => `${b.id} ${f}`)),
    notext: window.__app.state.blocks.filter((b) => window.__app.looksNotText(b)).map((b) => b.id),
    texts: Object.fromEntries(window.__app.state.blocks.map((b) => [b.id, b.originalText || ''])),
  }));
  console.log(`  교정: ${ocr.fixed.join('  |  ') || '없음'}`);
  console.log(`  그림으로 판정: ${ocr.notext.join(' ') || '없음'}`);

  // kor+eng 는 한글을 라틴으로 읽는 일이 잦다. 실측: 핵집→“HS, 핵심집약→BYU
  check('한글이 라틴으로 잘못 읽힌 것을 고친다',
    /핵집/.test(ocr.texts.b1) && /핵심집약/.test(ocr.texts.b18),
    `b1 "${ocr.texts.b1.slice(0, 8)}" · b18 "${ocr.texts.b18.slice(0, 12)}"`);
  // 진짜 영문은 건드리면 안 된다
  check('진짜 영문은 그대로 둔다',
    /EVENT/.test(ocr.texts.b0) && /UPGRADE/.test(ocr.texts.b18) && /UP!/.test(ocr.texts.b19),
    `${ocr.texts.b0} / UPGRADE ${/UPGRADE/.test(ocr.texts.b18)} / UP! ${/UP!/.test(ocr.texts.b19)}`);
  // 선물카드의 포크·수저 아이콘이 글자로 검출돼 쓰레기를 뱉는다
  check('그림 블록 5개를 다 걸러낸다',
    ['b4', 'b5', 'b6', 'b8', 'b9'].every((id) => ocr.notext.includes(id)),
    ocr.notext.join(' '));
  check('진짜 글자를 그림으로 오인하지 않는다',
    !['b0', 'b1', 'b2', 'b3', 'b13', 'b14', 'b16', 'b18', 'b19']
      .some((id) => ocr.notext.includes(id)), ocr.notext.join(' '));

  // ---- 계측과 합성이 같은 값을 쓰는가 ----
  console.log('\n[계측 = 합성]');
  const same = await page.evaluate(() => {
    const st = window.__app.state;
    const b = st.blocks.find((x) => x.originalText && !x.locked);
    const font = window.__app.fontFor(b);
    const c = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
    const L = Compose.util.layout(c, b, font);
    const m = Typo.measure(st.imageData, b, font);
    return {id: b.id, layoutSize: L.size, typoSize: m.size.px,
            layoutAlign: L.align, typoAlign: m.align.value};
  });
  check('크기가 합성 경로와 같다', Math.abs(same.layoutSize - same.typoSize) < 1e-9,
    `${same.layoutSize.toFixed(3)} / ${same.typoSize.toFixed(3)}`);
  check('정렬이 합성 경로와 같다', same.layoutAlign === same.typoAlign, same.typoAlign);

  // ---- 패널 ----
  console.log('\n[패널]');
  const target = await page.evaluate(() =>
    window.__app.state.blocks.find((b) => b.originalText && !b.locked).id);
  await page.evaluate((id) => window.__app.selectBlock(id), target);

  // 판정 문장이 제일 먼저·크게 보여야 한다. 수치는 접혀 있는 게 정상이다.
  check('판정 문장이 먼저 보인다', await page.isVisible('#verdict')
    && (await page.textContent('#verdict')).length > 10,
    await page.textContent('#verdict'));
  check('블록 제목에 안전도 칩이 붙는다',
    (await page.$$('#editorTitle .chip')).length === 1,
    await page.textContent('#editorTitle'));
  check('수치는 기본으로 접혀 있다',
    await page.evaluate(() => !document.getElementById('typoWrap').open));
  check('접힌 상태에서도 총점은 보인다',
    /%$/.test(await page.textContent('#typoTotalMini')),
    await page.textContent('#typoTotalMini'));

  await page.click('#typoWrap > summary');
  check('펴면 패널이 뜬다', await page.isVisible('#typoPanel'));
  const keys = await page.evaluate(() =>
    [...document.querySelectorAll('#typoPanel .typo-k')].map((n) => n.textContent));
  check('다섯 항목이 다 있다',
    ['글꼴', '글자 크기', '글자 사이 (자간)', '줄 사이 (행간)', '가로 위치']
      .every((k) => keys.includes(k)), keys.join(' / '));
  check('전문 용어를 그대로 쓰지 않는다',
    !keys.includes('폰트') && !keys.includes('자간') && !keys.includes('행간'), keys.join(' / '));

  const before = await page.textContent('#typoTotalMini');
  await page.selectOption('#fontSelect', {label: 'Black Han Sans 400 (판별 제외)'});
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.getElementById('typoWrap').open = true; });
  const after = await page.evaluate(() => ({
    total: document.getElementById('typoTotalMini').textContent,
    font: document.querySelectorAll('#typoPanel .typo-v')[0].textContent.trim(),
  }));
  check('폰트를 바꾸면 다시 계산한다', after.font.startsWith('Black Han Sans'),
    `${before} → ${after.total} / ${after.font}`);
  await page.selectOption('#fontSelect', {label: '자동판별'});

  console.log('\n[안전도 판정]');
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('#blockList .item')].map((n) => ({
      id: n.dataset.id, chip: n.querySelector('.chip')?.textContent || null,
    })));
  for (const c of chips) console.log(`  ${c.id.padEnd(4)} ${c.chip}`);
  check('모든 블록에 판정이 붙는다', chips.every((c) => c.chip), JSON.stringify(chips));
  check('판정은 정해진 말만 쓴다',
    chips.every((c) => ['안전', '글꼴 다름', '문구 확인', '위험', '편집 불가', '글자 아님', '대기'].includes(c.chip)),
    [...new Set(chips.map((c) => c.chip))].join(' / '));
  check('유형 문자(A/B/C)를 그대로 보여 주지 않는다',
    !chips.some((c) => /^[ABC]$/.test(c.chip)));

  // ---- 수정 초기화 ----
  console.log('\n[수정 초기화]');
  check('수정 전에는 눌리지 않는다',
    await page.getAttribute('#revertAllBtn', 'disabled') !== null);
  await page.evaluate(async (id) => {
    const app = window.__app;
    app.selectBlock(id);
    app.state.blocks.find((b) => b.id === id).draft = '초기화 시험';
    await app.saveBlock();
  }, target);
  check('수정하면 개수와 함께 열린다',
    await page.getAttribute('#revertAllBtn', 'disabled') === null
    && /\(1\)/.test(await page.textContent('#revertAllBtn')),
    await page.textContent('#revertAllBtn'));
  page.once('dialog', (d) => d.accept());
  await page.click('#revertAllBtn');
  await page.waitForFunction(() => !window.__app.state.blocks.some((b) => b.dirty),
    null, {timeout: 60000});
  const restored = await page.evaluate((id) => {
    const b = window.__app.state.blocks.find((x) => x.id === id);
    return {draft: b.draft, orig: b.originalText, hasImage: !!window.__app.state.imageData,
            result: !!window.__app.state.result};
  }, target);
  check('원문으로 되돌아간다', restored.draft === restored.orig);
  check('파일은 그대로 남는다 (예전 초기화와 다른 점)', restored.hasImage);
  check('결과 화면도 정리된다', !restored.result);

  await page.evaluate((id) => window.__app.selectBlock(id), target);
  await page.screenshot({path: path.join(OUT, 'typo-panel.png'), fullPage: true});

  console.log(`\n통과 ${pass} · 실패 ${fail}${errors.length ? `\n콘솔 오류: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  server.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
