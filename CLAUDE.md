# Wskazówki dla pracy nad core-api

## Mapa aplikacji — utrzymuj ją na bieżąco
`MAPA.md` to drogowskaz całego backendu (co i gdzie jest). **Przed** zmianą zajrzyj
do niej, żeby trafić w odpowiednie miejsce. **Po** zmianie — w TYM SAMYM commicie
zaktualizuj `MAPA.md`:
- nowy route/endpoint → dopisz do tabeli tras (sekcja 2) lub opisu pliku,
- nowy serwis/klient/util → dopisz w sekcji 3/4,
- nowy model/pole Prisma → sekcja 5,
- nowy istotny przepływ → sekcja 6.

Jeśli zmiana czyni MAPĘ nieaktualną, popraw MAPĘ. Mapa frontu: `../core-crm-frontend/MAPA.md`.

## Inne
- Deploy: `npx prisma db push && node src/index.js` — nowe modele/pola wchodzą same.
- Idempotencja wystawiania FV/WZ: `src/services/confirm-lock.js`.
- Modele Anthropic przez env; działające: `claude-opus-4-8`, `claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001`.
