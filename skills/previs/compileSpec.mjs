#!/usr/bin/env node
/**
 * compileSpec.mjs — 把「简版场景描述 brief」编译成 DirectorState JSON。
 *
 * 目的：让 LLM / 用户不必手写完整的 DirectorState（字段太多），用接近自然语言意图的
 * 精简结构描述，再由本脚本产出可被 App / MCP 直接 importScene 的 JSON。
 *
 * 用法：
 *   node compileSpec.mjs brief.json > scene.json
 *   echo '{ ...brief... }' | node compileSpec.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

// 解析 --out <path> 参数（指定时把结果写成 UTF-8 文件，避免 shell 重定向带来的编码/ BOM 问题）。
function parseOutPath() {
  const i = process.argv.indexOf("--out");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith("--out="));
  return eq ? eq.slice("--out=".length) : undefined;
}

function readInput() {
  const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
  if (file) return readFileSync(file, "utf8");
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

function buildScene(brief) {
  const objects = (brief.actors || []).map((a, i) => ({
    id: a.id || `ACTOR_${i + 1}`,
    type: a.type || "actor",
    category: a.category || "human",
    role: a.role || "actor",
    x: a.x ?? 0,
    z: a.z ?? 0,
    rotation: a.rotation ?? 0,
    footprint: a.footprint || { w: 0.6, d: 0.6, h: 1.8 },
    color: a.color || "#8ad1ff",
    locked: a.locked || false,
    ...(a.pose ? { pose: a.pose } : {}),
  }));

  // 由 actor.path（[[x,z],...] 路点）生成 MOVE 段。
  const segments = [];
  let segId = 0;
  for (const a of brief.actors || []) {
    if (!Array.isArray(a.path) || a.path.length < 2) continue;
    const pts = a.path;
    const [sx, sz] = pts[0];
    const [ex, ez] = pts[pts.length - 1];
    const points = pts.slice(1, -1).map((p, idx) => ({
      id: `P${segId}_${idx}`,
      type: "path",
      shape: "LINE",
      x: p[0],
      z: p[1],
    }));
    segments.push({
      id: `SEG_${segId}`,
      type: "MOVE",
      object: a.id || `ACTOR_${brief.actors.indexOf(a) + 1}`,
      startX: sx,
      startZ: sz,
      endX: ex,
      endZ: ez,
      points,
    });
    segId++;
  }

  const cameras = (brief.cameras || []).map((c, i) => ({
    id: c.id || `CAM_${i + 1}`,
    name: c.name || c.id || `CAM_${i + 1}`,
    color: c.color || "#c792ea",
    targetId: c.target || objects[0]?.id || "",
    framing: c.framing || "medium",
    view: c.view || "eye_level",
    side: c.side || "back_3_4",
    lensMm: c.lens ?? 35,
    motion: c.motion || "FOLLOW",
    kind: c.kind || "ground",
    ...(c.roll != null ? { roll: c.roll } : {}),
    ...(c.shoulderId ? { shoulderId: c.shoulderId } : {}),
    ...(c.otsSide ? { otsSide: c.otsSide } : {}),
    ...(c.otsOffset != null ? { otsOffset: c.otsOffset } : {}),
  }));

  const cameraMoves = [];
  let mvId = 0;
  (brief.cameras || []).forEach((c, i) => {
    const camId = c.id || `CAM_${i + 1}`;
    for (const m of c.moves || []) {
      cameraMoves.push({
        id: `MV_${mvId++}`,
        camera: camId,
        type: m.type || "FOLLOW",
        timeStart: m.start ?? 0,
        timeEnd: m.end ?? brief.duration ?? 5,
        ...(m.target || c.target ? { targetId: m.target || c.target } : {}),
        ...(m.shoulderId ? { shoulderId: m.shoulderId } : {}),
        ...(m.otsSide ? { otsSide: m.otsSide } : {}),
        ...(m.otsOffset != null ? { otsOffset: m.otsOffset } : {}),
        orbitDeg: m.orbitDeg ?? 0,
        dollyScale: m.dollyScale ?? 1,
        craneHeight: m.craneHeight ?? 0,
        ...(m.roll != null ? { roll: m.roll } : {}),
        ...(m.lens != null ? { lensMm: m.lens } : {}),
        ease: m.ease || [0.42, 0, 0.58, 1],
      });
    }
  });

  const constraints = (brief.constraints || []).map((c, i) => ({
    id: c.id || `CON_${i + 1}`,
    type: c.type || "LOOK_AT",
    subject: c.subject,
    target: c.target,
    timeStart: c.start ?? 0,
    timeEnd: c.end ?? brief.duration ?? 5,
  }));

  return {
    revision: 1,
    duration: brief.duration ?? 5,
    aspectRatio: brief.aspectRatio || "16:9",
    objects,
    segments,
    handoffs: [],
    constraints,
    cameras,
    cameraMoves,
    cameraJunctions: [],
    actions: [],
  };
}

const raw = await readInput();
const brief = JSON.parse(raw);
const scene = buildScene(brief);
const json = JSON.stringify(scene, null, 2);
const outPath = parseOutPath();
if (outPath) {
  // 显式 UTF-8 无 BOM 写入文件，跨 shell 都安全。
  writeFileSync(outPath, json, { encoding: "utf8" });
} else {
  // 写 Buffer 原始字节，避免 PowerShell 等把 stdout 重编码成 UTF-16 / 加 BOM。
  process.stdout.write(Buffer.from(json, "utf8"));
}
