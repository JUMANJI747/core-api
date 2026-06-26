# core-api — backend Surf Stick Bell (CRM + automatyzacja)

> ## 🧭 START TUTAJ (dla człowieka i dla modelu AI)
> Nie znasz tego kodu? **Przeczytaj najpierw [`MAPA.md`](./MAPA.md)** — to drogowskaz
> całej aplikacji: co i gdzie jest (trasy, serwisy, modele, przepływy).
> Zasady pracy nad repo: [`CLAUDE.md`](./CLAUDE.md) (m.in. obowiązek aktualizacji MAPY).

## Co to jest

Backend (Node/Express + Prisma/Postgres) CRM-u i automatyzacji księgowo-logistycznej
dla **Surf Stick Bell**. Obsługuje:
- **Faktury PL** przez iFirma (+ KSeF, JPK),
- **Faktury Kanary/ES** przez Contasimple (IGIC 7%, WZ/albaran),
- **Wysyłki kurierskie** przez GlobKurier,
- **Maile** (odbiór IMAP + klasyfikacja AI + powiadomienia Telegram),
- **Agentów AI** (Anthropic) sterowanych z Telegrama (master w n8n) i z panelu CRM.

## Powiązane repo

- **Frontend (panel CRM):** `jumanji747/core-crm-frontend` — Next.js, gada z tym
  backendem przez proxy `/api/core/...`. Jego mapa: `core-crm-frontend/MAPA.md`.

## Uruchomienie / deploy

```bash
npm install
npx prisma db push      # tworzy/aktualizuje schemat (nowe modele/pola wchodzą same)
node src/index.js       # start API
```
Produkcja (Railway): `start` = `npx prisma db push && node src/index.js`.
Auth: nagłówek `x-api-key` (env `API_KEY`). Konfiguracja: env + tabela `Config`.

## Gdzie czego szukać (skrót — pełna lista w MAPA.md)

- Wejście + montaż tras: `src/index.js`
- Faktury PL: `src/routes/invoices.js` (+ `src/ifirma-client.js`, `src/services/ifirma-payload.js`)
- Faktury ES: `src/routes/contasimple.js`
- Kurier: `src/routes/glob-quote.js` / `glob-orders.js` (+ `src/glob-client.js`)
- Agenci AI: `src/routes/agent.js` + `src/services/*-agent.js`
- Maile: `src/inbox-poller.js`
- Księgowość/WDT: `src/routes/accounting.js`, `src/services/wdt-pairing.js`
- Modele danych: `prisma/schema.prisma`
