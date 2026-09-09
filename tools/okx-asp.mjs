// okx-asp.mjs — 以参数数组方式调用 onchainos（避免 PowerShell 拆分含空格的 JSON 参数）
//
// 用法:
//   node .tools/okx-asp/okx-asp.mjs validate
//   node .tools/okx-asp/okx-asp.mjs create
//   node .tools/okx-asp/okx-asp.mjs create --force
//   node .tools/okx-asp/okx-asp.mjs <任意 onchainos 参数...>

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BIN = "C:\\Users\\10671\\.local\\bin\\onchainos.exe";
const DIR = path.join(process.cwd(), ".tools", "okx-asp");

const desc = fs.readFileSync(path.join(DIR, "description.txt"), "utf8").trim();
const svc = fs.readFileSync(path.join(DIR, "listing.json"), "utf8").replace(/\r\n/g, "\n");
const picture = fs
  .readFileSync(path.join(DIR, "picture.txt"), "utf8")
  .trim();

const cmd = process.argv[2];
const extra = process.argv.slice(3);

const A2A_PATH = path.join(DIR, "listing-a2a.json");
const a2aRaw = fs.existsSync(A2A_PATH) ? JSON.parse(fs.readFileSync(A2A_PATH, "utf8")) : [];
// validate 用：去掉 operation/id
const a2aForValidate = a2aRaw.map(({ operation, id, ...rest }) => rest);
// update 用：带 operation:create
const a2aForUpdate = a2aRaw.map((x) => ({ operation: "create", ...x }));

let args;
if (cmd === "validate") {
  args = ["agent", "validate-listing", "--role", "asp", "--name", "AgentLens", "--description", desc, "--service", svc];
} else if (cmd === "validate-a2a") {
  args = [
    "agent",
    "validate-listing",
    "--role",
    "asp",
    "--name",
    "AgentLens",
    "--description",
    desc,
    "--service",
    JSON.stringify(a2aForValidate),
  ];
} else if (cmd === "update-a2a") {
  args = [
    "agent",
    "update",
    "--agent-id",
    "13437",
    "--service",
    JSON.stringify(a2aForUpdate),
    ...extra,
  ];
} else if (cmd === "create") {
  args = [
    "agent",
    "create",
    "--role",
    "asp",
    "--name",
    "AgentLens",
    "--description",
    desc,
    "--picture",
    picture,
    "--service",
    svc,
    ...extra,
  ];
} else {
  args = process.argv.slice(2);
}

console.log(">> onchainos " + args.slice(0, 2).join(" ") + ` (${args.length} args)`);
const r = spawnSync(BIN, args, { stdio: "inherit", cwd: process.cwd() });
console.log("exit:", r.status);
