FROM node:24-alpine
RUN apk add --no-cache python3 py3-pip \
 && pip3 install --break-system-packages --no-cache-dir openpyxl xlrd
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY backend/*.mjs ./
COPY backend/hr-excel ./hr-excel
COPY scripts/migrate-hr.mjs ./migrate-hr.mjs
COPY index.html ./public/index.html
COPY public/hr-app.js public/hr.css ./public/
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
