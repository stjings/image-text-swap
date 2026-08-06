/* localfont.js — 사용자 PC에 설치된 폰트를 후보로 쓴다.
 * PLAN.md 8-2
 *
 * 헤드라인에 쓰인 유료 폰트(산돌 등)는 저장소에 넣을 수 없다. 폰트 파일은
 * 저작물이고, 공개 배포되는 이 앱에 함께 올리면 재배포가 된다. 글자 모양을
 * 보고 다시 그리는 것도 같은 문제다 — 그건 새 폰트가 아니라 복제본이다.
 *
 * 대신 브라우저의 `local()` 소스를 쓴다. 폰트를 산 사람의 PC에는 그 폰트가
 * 이미 설치돼 있으므로, 그 자리에서 불러 캔버스에 그린다. 서버도 저장소도
 * 폰트 파일을 갖지 않는다. 재배포가 아니라 각자 산 폰트를 각자 쓰는 것이다.
 *
 * 등록 방식
 *   new FontFace(alias, 'local("이름")') → load()
 *   설치돼 있지 않으면 load() 가 NetworkError 로 거부된다(실측 확인). 즉
 *   등록 시도 자체가 설치 여부 검사를 겸한다. 따로 확인할 필요가 없다.
 *
 * 이름 열거(queryLocalFonts)는 Chromium 계열 + 보안 컨텍스트에서만 되고
 * 권한 승인도 필요하다. 그래서 열거는 '편의'로만 두고, 이름을 직접 적어
 * 넣는 길을 항상 열어 둔다. 열거가 막힌 브라우저에서도 기능은 동작한다.
 */
'use strict';

const LocalFont = (() => {

  const KEY = 'its.localfonts.v1';
  const added = [];   // {ps, name, family, weight, label, local:true}

  /** 열거 API 지원 여부. 등록 자체는 이것과 무관하게 항상 가능하다. */
  const canEnumerate = () => typeof window.queryLocalFonts === 'function';

  /** 번들 폰트와 절대 겹치지 않는 가족 이름을 만든다. */
  const aliasOf = (ps) => 'LF ' + ps.replace(/["\\]/g, '');

  const list = () => added.slice();
  const has = (ps) => added.some((f) => f.ps === ps);

  /* ---------- 저장 ---------- */

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(
        added.map((f) => ({ps: f.ps, name: f.name, group: f.group}))));
    } catch (e) { /* 사생활 보호 모드 등. 저장 못 해도 이번 세션은 동작한다 */ }
  }

  function stored() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  /* ---------- 등록 ---------- */

  /**
   * 이름(풀네임 또는 PostScript 이름)으로 설치된 폰트를 등록한다.
   * @throws 설치돼 있지 않으면 Error
   */
  async function add(ps, name, group) {
    ps = (ps || '').trim();
    if (!ps) throw new Error('폰트 이름이 비어 있습니다.');
    const dup = added.find((f) => f.ps === ps);
    if (dup) return dup;

    const family = aliasOf(ps);
    const face = new FontFace(family, `local("${ps}")`);
    try {
      await face.load();
    } catch (e) {
      throw new Error(`"${ps}" 폰트가 이 PC에 설치돼 있지 않습니다.`);
    }
    document.fonts.add(face);

    const f = {
      family, weight: 400, ps, name: name || ps,
      // 다수결이 묶는 단위. 같은 폰트의 Regular/Bold 는 별칭이 달라도 한 묶음이다.
      group: group || name || ps,
      label: `${name || ps} · 내 PC`, local: true,
    };
    added.push(f);
    persist();
    return f;
  }

  function remove(ps) {
    const i = added.findIndex((f) => f.ps === ps);
    if (i < 0) return false;
    added.splice(i, 1);
    persist();
    return true;
  }

  /**
   * 지난 세션에 고른 폰트를 다시 등록한다.
   * 등록에는 권한이 필요 없으므로 조용히 처리된다. 폰트를 지웠거나 다른 PC
   * 라면 그냥 빠진다 — 실패를 알릴 일이 아니다.
   * @returns {{ok:number, gone:string[]}}
   */
  async function restore() {
    const gone = [];
    let ok = 0;
    for (const s of stored()) {
      try { await add(s.ps, s.name, s.group); ok++; }
      catch (e) { gone.push(s.name || s.ps); }
    }
    if (gone.length) persist();   // 사라진 것은 목록에서도 지운다
    return {ok, gone};
  }

  /* ---------- 열거 ---------- */

  /**
   * 설치된 폰트 목록. 사용자 제스처 안에서 불러야 하고 권한 승인을 받는다.
   * @returns {Promise<Array<{ps,name,family,style}>>}
   * @throws 지원하지 않거나 사용자가 거부하면 Error
   */
  async function enumerate() {
    if (!canEnumerate()) {
      throw new Error('이 브라우저는 폰트 목록 보기를 지원하지 않습니다. '
        + '아래에 폰트 이름을 직접 적어 넣으세요.');
    }
    let data;
    try {
      data = await window.queryLocalFonts();
    } catch (e) {
      throw new Error('폰트 목록 접근이 거부되었습니다. 주소창의 권한 설정에서 '
        + '허용하거나, 아래에 이름을 직접 적어 넣으세요.');
    }
    return data.map((d) => ({
      ps: d.postscriptName, name: d.fullName || d.postscriptName,
      family: d.family, style: d.style,
    })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  return {canEnumerate, enumerate, add, remove, restore, list, has};
})();
