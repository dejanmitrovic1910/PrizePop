FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Generate Prisma client at build time (no DB needed)
RUN npx prisma generate

RUN npm run build

# Run only the app at startup. Run migrations in Render's "Release Command": npx prisma migrate deploy
CMD ["npm", "run", "start"]
