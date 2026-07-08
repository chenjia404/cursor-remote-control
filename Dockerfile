FROM node:alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false

COPY . .
RUN pnpm build

EXPOSE 20267

CMD ["pnpm", "start"]
