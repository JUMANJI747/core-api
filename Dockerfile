# Obraz produkcyjny core-api.
#
# DLACZEGO Dockerfile, skoro był nixpacks.toml:
#   /karta-pracy/crop i /karty-pracy/odczytaj wywalały się na produkcji z
#   „spawn pdfinfo ENOENT", mimo że poppler-utils od dawna stał w
#   nixpacks.toml → aptPkgs. Ten plik był więc martwą konfiguracją: albo
#   builder go nie czyta, albo pakiety lądowały tylko w warstwie build i nie
#   trafiały do obrazu runtime. Nie dało się tego wykryć wcześniej, bo
#   ghostscript (jedyny wcześniejszy wpis) ma w kodzie łańcuch fallbacków
#   (jpk-package: gs → qpdf → pdfunite → pdftk), a /preprocess-scan nigdy nie
#   był wołany. Dockerfile usuwa domysły: jest jawną definicją obrazu, którą
#   Railway bierze przed automatycznym wykrywaniem buildera.
#
# Weryfikacja po deployu: GET /api/_version → pole "binaria" (realne
# uruchomienie pdfinfo/pdftoppm/convert, nie odczyt configu).

FROM node:22-bookworm-slim

# Binaria potrzebne w RUNTIME, nie tylko w buildzie:
#   poppler-utils : pdfinfo, pdftoppm, pdfunite  (karty pracy, preprocess-scan, scalanie JPK)
#   imagemagick   : convert -deskew              (prostowanie skanów)
#   tesseract-ocr : OSD, wykrycie obrotu strony  (preprocess-scan)
#   ghostscript   : scalanie PDF                 (jpk-package)
#   openssl       : wymagany przez silniki Prisma na obrazach slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils \
      imagemagick \
      ghostscript \
      tesseract-ocr \
      openssl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# prisma/ musi być NA MIEJSCU przed npm ci — postinstall odpala `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY . .

# Ten sam start co dotąd (skrypt "start" z package.json): migracja schematu,
# potem serwer. PORT wstrzykuje Railway, kod czyta process.env.PORT.
CMD ["sh", "-c", "npx prisma db push && node src/index.js"]
