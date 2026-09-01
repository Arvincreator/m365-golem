import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { pingEndpoint } from "@/lib/server-http";

export async function POST() {
  console.log("🚀 [Launcher] Received remote start request...");

  const cwd = process.cwd();
  console.log(`📂 [Launcher] Current Working Directory: ${cwd}`);

  // 移除路徑末尾的斜槓並檢查是否以 web-dashboard 結尾
  const normalizedCwd = cwd.replace(/[/\\]$/, "");
  const rootDir = normalizedCwd.endsWith("web-dashboard") ? path.resolve(normalizedCwd, "..") : normalizedCwd;
  
  // Verify if we are in the right place by checking for package.json
  const hasPackageJson = fs.existsSync(path.join(rootDir, "package.json"));
  console.log(`🔍 [Launcher] Target Root: ${rootDir} (package.json: ${hasPackageJson})`);

  if (!hasPackageJson) {
    console.error("❌ [Launcher] Could not find project root containing package.json");
    return NextResponse.json({ success: false, error: "Project root not found" }, { status: 500 });
  }

  // Check Port 3001
  const isBackendReady = await pingEndpoint("http://127.0.0.1:3001/api/system/status", { timeoutMs: 500 });
  if (isBackendReady) {
    console.log("⚠️ [Launcher] Backend is already running on Port 3001.");
    return NextResponse.json({ success: true, message: "Backend is already active" });
  }

  console.log(`📡 [Launcher] Spawning Golem process...`);

  const child = spawn("npm", ["run", "dashboard"], {
    cwd: rootDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DASHBOARD_DEV_MODE: "true" }
  });

  child.on('error', (err) => {
    console.error("🔥 [Launcher] Spawn error:", err);
  });

  child.unref();

  return NextResponse.json({ 
    success: true, 
    message: "Golem startup sequence initiated." 
  });
}
