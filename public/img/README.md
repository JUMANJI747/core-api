# public/img — obrazki do maili (stopka + treść)

Serwowane anonimowo pod `https://<host>/img/<plik>` (montaż w `src/index.js`,
przed autoryzacją: klienty pocztowe pobierają je bez nagłówków).

Dwa rodzaje zawartości:
- **stopka** — logo i ikony social (`abcwork-*`, `ola-foto.png`),
- **treść maili** — zdjęcia marketingowe (`surfstick-*`), przeskalowane pod
  maila: dłuższy bok 1200 px (portret 900), JPEG q82 progresywny, ~70-200 kB.
  Oryginały ważyły po 2-5 MB, co w mailu jest zbędnym ciężarem. Konwersja
  przez `Image.convert('RGB')` gubi też EXIF, więc do odbiorcy nie idą
  metadane aparatu ani lokalizacja.

Zasady:
- **nie podmieniaj treści pliku pod tym samym adresem** — nagłówek to
  `Cache-Control: max-age=2592000, immutable`, więc Gmail i Outlook trzymają
  starą wersję tygodniami. Zmiana grafiki = NOWA nazwa pliku,
- `_sonda.png` (1×1, przezroczysty) zostaje na stałe: pozwala sprawdzić
  jednym `curl -sI .../img/_sonda.png`, czy statyk stoi i czy nie zasłonił go
  żaden middleware — bez ruszania plików marki.
