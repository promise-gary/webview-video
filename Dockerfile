FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html styles.css vite.config.js ./
COPY src ./src
RUN npm run build

FROM nginx:1.30.4-alpine3.24

# 运行镜像只包含压缩后的静态产物，不包含 Node.js、源码和构建依赖。
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
