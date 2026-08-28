# Obraz samodzielnego serwisu Czytnika.
# Railway: nowy serwis z tego samego repo, Root Directory = czytnik,
# Watch Paths = czytnik/**  ->  deploy niezależny od core-api.

FROM node:22-bookworm-slim

# poppler-utils: pdfinfo, pdftoppm (render stron)
# imagemagick  : convert -deskew (prostowanie skanu)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils \
      imagemagick \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "src/index.js"]
