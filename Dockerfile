FROM node:22-alpine

WORKDIR /app

RUN npm install -g pnpm@latest
RUN pnpm config set minimum-release-age 0
RUN pnpm config set dangerously-allow-all-builds true

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile=false

COPY . .
RUN pnpm build

EXPOSE 20267

CMD ["node", "dist/src/server.js"]
