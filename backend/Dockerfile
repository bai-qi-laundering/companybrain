FROM node:24-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY backend/*.mjs ./
COPY index.html ./public/index.html
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
