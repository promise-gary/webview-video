import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Render 要求公网服务监听 0.0.0.0；本地仍通过 http://127.0.0.1:4173 访问。
const HOST = '0.0.0.0';
const DEFAULT_PORT = 4173;

// 视频和服务端放在同一个独立仓库内，不依赖原项目中的任何文件。
const VIDEO_DIRECTORY = fileURLToPath(new URL('./videos/', import.meta.url));

const videoFilesPromise = readdir(VIDEO_DIRECTORY, { withFileTypes: true }).then((entries) => {
  const videoFiles = entries
    .filter((entry) => entry.isFile() && /\.webm$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  if (videoFiles.length === 0) {
    throw new Error(`videos 目录中没有找到 WebM 文件：${VIDEO_DIRECTORY}`);
  }

  return videoFiles;
});

async function pickRandomVideoPath() {
  const videoFiles = await videoFilesPromise;
  const randomIndex = Math.floor(Math.random() * videoFiles.length);
  return join(VIDEO_DIRECTORY, videoFiles[randomIndex]);
}

async function writeVideoFile(response, videoPath) {
  try {
    await pipeline(createReadStream(videoPath), response);
  } catch (error) {
    // 浏览器取消请求属于正常媒体加载行为，不需要作为服务端错误输出。
    if (response.destroyed || error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    throw error;
  }
}

async function serveVideo(request, response) {
  const videoPath = await pickRandomVideoPath();
  const videoStats = await stat(videoPath);
  response.writeHead(200, {
    'Content-Type': 'video/webm',
    'Content-Length': videoStats.size,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length',
  });

  console.log(`[video] status=200 file=${videoPath.split('/').at(-1)} bytes=${videoStats.size}`);

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  await writeVideoFile(response, videoPath);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Max-Age': '86400',
      });
      response.end();
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' });
      response.end('Method Not Allowed');
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? HOST}`);

    if (url.pathname === '/health') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname === '/video') {
      await serveVideo(request, response);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
    } else if (!response.destroyed) {
      response.destroy(error);
    }
  }
});

// Render 注入 PORT；NODE_SERVER_PORT 保留给其他平台或本地自定义端口使用。
const configuredPort = Number.parseInt(
  process.env.PORT ?? process.env.NODE_SERVER_PORT ?? '',
  10,
);
const port = Number.isFinite(configuredPort) ? configuredPort : DEFAULT_PORT;

server.listen(port, HOST, () => {
  console.log(`Transparent video resource server: http://${HOST}:${port}`);
  console.log(`Video endpoint: /video`);
  videoFilesPromise
    .then((videoFiles) => console.log(`Video sources: ${videoFiles.join(', ')}`))
    .catch((error) => console.error(`[video] ${error.message}`));
});
