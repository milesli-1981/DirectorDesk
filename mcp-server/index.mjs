#!/usr/bin/env node
/**
 * Director Desk · Previs MCP server
 * ----------------------------------------------------------------------------
 * 暴露一个工具：render_previs(sceneJson) -> 视频文件。
 *
 * 原理（Playwright 复用现有渲染，零重写）：
 *   1. 起一个本地 HTTP 接收器，把 App 上传的视频 Blob 落盘到临时文件。
 *   2. 启动无头 Chromium，加载已运行的 Director Desk Web App（?headless=1）。
 *   3. 调用页面上的 window.previsRender({ scene, camera, fps, receiver })：
 *      App 导入场景 -> 录制指定相机 POV（MediaRecorder）-> 上传到接收器。
 *   4. 返回视频文件的绝对路径（及 file:// 资源），供 MCP 客户端打开。
 *
 * 前置：
 *   - 先 `npm run dev` 把 Web App 跑在 http://localhost:5173（可用 PREVIS_APP_URL 覆盖）。
 *   - `npx playwright install chromium` 安装无头浏览器。
 */

import http from "node:http";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const APP_URL = process.env.PREVIS_APP_URL || "http://localhost:5173";
const RENDER_TIMEOUT_MS = Number(process.env.PREVIS_TIMEOUT_MS || 300_000);

/** 起一个一次性接收器：POST 的 body 存成临时 webm，res 回写其路径。 */
function startReceiver() {
  const dir = mkdtempSync(join(tmpdir(), "previs-"));
  let resolveUpload;
  const uploaded = new Promise((res) => (resolveUpload = res));
  const server = http.createServer((req, res) => {
    // 接收器与 Web App 不同源（127.0.0.1 vs localhost），需放开 CORS 才能让页面 fetch 上传视频。
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const file = join(dir, `previs-${Date.now()}.webm`);
        writeFileSync(file, Buffer.concat(chunks));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ path: file }));
        resolveUpload(file);
      });
      return;
    }
    res.end("ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/upload`, uploaded });
    });
  });
}

const server = new McpServer({
  name: "directdesk-previs",
  version: "0.1.0",
});

server.tool(
  "render_previs",
  "输入导演场景 JSON（DirectorState 或整片场），渲染并返回一段预演视频文件。" +
    "场景可由自然语言经 skill 的 spec 编译器生成。返回视频的本地绝对路径。",
  {
    scene: z
      .string()
      .describe("场景 JSON 字符串：DirectorState 单场景，或 { manifest, scenes } 整片场。"),
    camera: z
      .string()
      .optional()
      .describe("相机 id；省略则录制第一台相机。"),
    fps: z.number().int().min(1).max(60).optional().describe("帧率，默认 24。"),
    appUrl: z.string().optional().describe("Web App 地址，默认取自 PREVIS_APP_URL 或 http://localhost:5173。"),
  },
  async ({ scene, camera, fps, appUrl }) => {
    const target = appUrl || APP_URL;
    const receiver = await startReceiver();

    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        // 优先用本机已装的 Edge（免下载 Chromium）；可用 PREVIS_BROWSER 覆盖路径。
        executablePath:
          process.env.PREVIS_BROWSER ||
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        args: [
          "--no-sandbox",
          "--enable-unsafe-swiftshader",
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--ignore-gpu-blocklist",
        ],
      });
      const page = await browser.newPage();

      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));

      await page.goto(`${target}?headless=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // 等 App 挂载并装上无头 API，且画布已存在。
      await page.waitForFunction(
        () => typeof window.previsRender === "function" && !!document.querySelector("canvas"),
        { timeout: 30_000 },
      );

      let parsed;
      try {
        parsed = JSON.parse(scene);
      } catch {
        throw new Error("scene 不是合法 JSON");
      }

      const result = await page.evaluate(
        (req) => window.previsRender(req),
        { scene: parsed, camera, fps: fps ?? 24, receiver: receiver.url },
        { timeout: RENDER_TIMEOUT_MS },
      );

      if (result?.error) throw new Error(`渲染失败：${result.error}`);
      const path = result?.path;
      if (!path) throw new Error("渲染完成但未收到视频路径（receiver 未收到上传）");

      return {
        content: [
          {
            type: "text",
            text: `预演视频已生成：${path}\n（时长由场景决定，渲染为实时 1x）`,
          },
          {
            type: "resource",
            resource: { uri: `file://${path}`, mimeType: "video/webm", title: "previs video" },
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `render_previs 失败：${msg}` }],
        isError: true,
      };
    } finally {
      if (browser) await browser.close();
      receiver.server.close();
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Director Desk Previs MCP server running on stdio");
