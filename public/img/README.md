# public/img — obrazki stopki mailowej

Serwowane anonimowo pod `https://<host>/img/<plik>` (montaż w `src/index.js`,
przed autoryzacją: klienty pocztowe pobierają je bez nagłówków).

Zasady:
- **nie podmieniaj treści pliku pod tym samym adresem** — nagłówek to
  `Cache-Control: max-age=2592000, immutable`, więc Gmail i Outlook trzymają
  starą wersję tygodniami. Zmiana grafiki = NOWA nazwa pliku,
- `_sonda.png` (1×1, przezroczysty) zostaje na stałe: pozwala sprawdzić
  jednym `curl -sI .../img/_sonda.png`, czy statyk stoi i czy nie zasłonił go
  żaden middleware — bez ruszania plików marki.
