#!/usr/bin/env python3
"""배경 유형 판정(PLAN.md 7-1) 검증 도구.

앱 코드가 아니다. 7-1 알고리즘을 JS로 옮기기 전에 파이썬으로 먼저 돌려
판정 결과가 실물과 맞는지 확인하는 기획 검증용 스크립트다.

사용:
    pip install Pillow
    python3 tools/tier-probe.py                 # 전체 요약 + 기준 블록 판정
    python3 tools/tier-probe.py assets/x.png    # 특정 파일 요약만
"""

import collections
import statistics
import sys

from PIL import Image

# --- 7-1 임계값 ---
ALPHA_T = 20      # 투명 배경 판정 (알파 중앙값)
QUANT = 16        # 최빈색 양자화 단위
DIST_T = 30       # 배경 후보 색거리 (채널당)
SHARE_T = 0.45    # 배경이 차지해야 할 최소 비율
SIGMA_T = 8       # 단색 판정 표준편차


def judge(px, bbox):
    """PLAN.md 7-1 배경 유형 판정. (유형, 대표색, 알파중앙값, 배경점유율) 반환."""
    x0, y0, x1, y1 = bbox
    pix = [px[x, y] for y in range(y0, y1) for x in range(x0, x1)]

    # 1단계 — 알파 '중앙값'으로 투명 배경 판정.
    # 평균을 쓰면 글자 픽셀에 끌려 올라가 투명 배경을 놓친다.
    a_med = statistics.median(p[3] for p in pix)
    if a_med < ALPHA_T:
        return "A", None, a_med, None

    # 2단계 — 최빈색을 배경 후보로. 블록 안에서 배경이 글자보다 넓다는 가정.
    opaque = [p for p in pix if p[3] > 200]
    if not opaque:
        return "C", None, a_med, None

    q = collections.Counter((p[0] // QUANT, p[1] // QUANT, p[2] // QUANT) for p in opaque)
    cen = tuple(c * QUANT + QUANT // 2 for c in q.most_common(1)[0][0])
    near = [p for p in opaque if sum(abs(p[i] - cen[i]) for i in range(3)) < DIST_T * 3]

    share = len(near) / len(pix)
    if share < SHARE_T:
        return "C", None, a_med, share

    rep = tuple(int(statistics.median([p[i] for p in near])) for i in range(3))
    sigma = max(statistics.pstdev([p[i] for p in near]) for i in range(3))
    return ("B" if sigma < SIGMA_T else "C"), rep, a_med, share


def summarize(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    total = w * h
    a0 = amid = a255 = 0
    for y in range(h):
        for x in range(w):
            a = px[x, y][3]
            if a == 0:
                a0 += 1
            elif a == 255:
                a255 += 1
            else:
                amid += 1
    print(f"\n=== {path}  {w}x{h} ({total:,}px) ===")
    print(f"  완전 투명   : {a0 / total * 100:6.2f}%")
    print(f"  반투명      : {amid / total * 100:6.2f}%")
    print(f"  완전 불투명 : {a255 / total * 100:6.2f}%")
    return px


# PLAN.md 4장 유형 표의 근거가 된 대표 블록. 좌표는 수동 측정값이므로
# 7-3 검출이 붙으면 이 목록은 자동 산출로 대체된다.
BLOCKS = {
    "assets/sample-simple.png": [
        ("글자 1행", (300, 20, 840, 75)),
        ("글자 2행", (330, 95, 810, 155)),
    ],
    "assets/sample-complex.png": [
        ("EVENT 02.", (490, 12, 650, 34)),
        ("인용문 1행", (255, 45, 885, 68)),
        ("헤드라인 1행", (310, 128, 830, 170)),
        ("배지 '추첨 5명'", (648, 302, 690, 352)),
        ("배지 '추첨 10명'", (252, 528, 300, 578)),
        ("각주 라인", (110, 715, 1020, 730)),
        ("파란박스 '이벤트 기간'", (45, 770, 290, 788)),
        ("파란박스 '이벤트 혜택'", (580, 795, 900, 815)),
    ],
}


def main():
    targets = sys.argv[1:] or list(BLOCKS)
    for path in targets:
        px = summarize(path)
        blocks = BLOCKS.get(path)
        if not blocks:
            continue
        print(f"\n  {'블록':<24} {'유형':<5} {'α중앙':>6} {'배경비율':>8}  대표색")
        print("  " + "-" * 66)
        for name, bbox in blocks:
            t, rep, a_med, share = judge(px, bbox)
            sh = f"{share * 100:.0f}%" if share is not None else "-"
            print(f"  {name:<24} {t:<5} {a_med:6.0f} {sh:>8}  {f'RGB{rep}' if rep else '-'}")


if __name__ == "__main__":
    main()
