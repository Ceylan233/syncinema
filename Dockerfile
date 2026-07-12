FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3100

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

EXPOSE 3100
CMD ["node", "server/server.js"]
