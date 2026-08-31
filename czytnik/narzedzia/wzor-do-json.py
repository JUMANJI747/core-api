#!/usr/bin/env python3
"""
wzor-do-json.py — jednorazowy ekstraktor wzoru karty ewidencji czasu pracy.

Bierze ORYGINALNY plik Ali (Karta_ewid.cz._pr.obowiazuje_OK.xls, arkusz „Wzór")
i zapisuje jego układ jako JSON: szerokości kolumn, wysokości wierszy, scalenia,
teksty, czcionki, wyrównania i style ramek każdej komórki.

Dzięki temu `src/karta-druk.js` nie przepisuje wzoru z palca — rysuje dokładnie
to, co jest w pliku kadrowym. Gdy Ala zmieni wzór, powtarzamy:

    pip install xlrd
    python3 narzedzia/wzor-do-json.py <plik.xls> assets/karta-wzor.json

Jednostki zostawiamy oryginalne (Excel): kolumny w 1/256 szerokości znaku,
wiersze w twipach (1/20 punktu) — przeliczenie na punkty PDF robi renderer.
"""
import json
import sys

import xlrd


def main(zrodlo, cel):
    b = xlrd.open_workbook(zrodlo, formatting_info=True)
    s = b.sheet_by_index(0)

    kolumny = [s.computed_column_width(c) for c in range(s.ncols)]
    wiersze = [s.rowinfo_map[r].height if r in s.rowinfo_map else s.default_row_height
               for r in range(s.nrows)]

    komorki = []
    for r in range(s.nrows):
        for c in range(s.ncols):
            cell = s.cell(r, c)
            xf = b.xf_list[cell.xf_index]
            bd, al = xf.border, xf.alignment
            fnt = b.font_list[xf.font_index]
            ramki = [bd.left_line_style, bd.right_line_style,
                     bd.top_line_style, bd.bottom_line_style]
            fmt = b.format_map[xf.format_key].format_str
            v = cell.value
            if isinstance(v, float):
                tekst = f"{v * 100:g}%" if '%' in fmt else f"{v:g}"
            else:
                tekst = str(v)
            tekst = tekst.strip()
            if not tekst and not any(ramki):
                continue                      # pusta i bez ramki — nie ma czego rysować
            komorki.append({
                "r": r, "c": c, "t": tekst,
                "ramki": ramki,
                "sz": fnt.height / 20.0, "pogrubiona": bool(fnt.bold),
                "poziomo": al.hor_align, "pionowo": al.vert_align,
                "zawijaj": bool(al.text_wrapped),
            })

    # przycinamy do realnie uzywanego zakresu (dalej jest tylko pustka)
    ile_kol = max(k["c"] for k in komorki) + 1
    ile_wier = max(k["r"] for k in komorki) + 1
    kolumny, wiersze = kolumny[:ile_kol], wiersze[:ile_wier]

    scalone = sorted([list(m) for m in s.merged_cells])
    out = {
        "zrodlo": zrodlo.split('/')[-1],
        "arkusz": s.name,
        "kolumnyXls": kolumny,      # 1/256 znaku
        "wierszeTwipy": wiersze,    # 1/20 pkt
        "scalone": scalone,         # [r0, r1, c0, c1] — r1/c1 wyłącznie
        "komorki": komorki,
    }
    with open(cel, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"{cel}: {len(komorki)} komorek, {len(scalone)} scalen, "
          f"{len(kolumny)} kolumn x {len(wiersze)} wierszy")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
