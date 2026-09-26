# syntax=docker/dockerfile:1

# 构建阶段：安装开发依赖并编译 TypeScript
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 运行阶段：无运行时依赖，只需编译产物
FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/cli.js"]
