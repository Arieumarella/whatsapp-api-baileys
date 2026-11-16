FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV BAILEYS_AUTH_PATH=/app/auth

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

VOLUME ["/app/auth"]

EXPOSE 5000

CMD ["node", "server.js"]