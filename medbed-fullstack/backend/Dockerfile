# Build context: ./medbed-fullstack  (the backend serves ../frontend)
FROM node:20-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY frontend/ /app/frontend/
ENV NODE_ENV=development PORT=5001
EXPOSE 5001
CMD ["sh", "-c", "node scripts/seedDemo.js && node server.js"]
