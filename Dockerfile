FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY bot.js .
ENV NODE_ENV=production
CMD ["node", "bot.js"]
