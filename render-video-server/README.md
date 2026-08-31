# Transparent Video Render Server

独立的透明 WebM 资源服务，可直接作为一个 Git 仓库部署到 Render。

## 本地运行

```bash
npm install
npm start
```

接口：

- `GET http://127.0.0.1:4173/health`
- `GET http://127.0.0.1:4173/video`
- `HEAD http://127.0.0.1:4173/video`

`/video` 使用普通 `200` 响应持续传输 WebM，并支持跨域请求。

## Render 配置

将整个文件夹上传到独立 GitHub 仓库，然后创建 Render Web Service：

```text
Language: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

部署完成后，视频地址为：

```text
https://你的服务名.onrender.com/video
```
