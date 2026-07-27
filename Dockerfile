# पूरा असली Chromium + सभी ज़रूरी fonts (Devanagari सहित) install करता है,
# ताकि PDF/Image export में कभी भी font की समस्या न आए।

FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto \
    fonts-noto-cjk \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

EXPOSE 7700

CMD ["npm", "start"]
