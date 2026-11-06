#!/usr/bin/env node
// Creates desktop shortcuts: “회의록” (start + open browser) and “회의록 종료” (save & stop).
// Usage: npm run shortcut            (both shortcuts)
//        npm run shortcut -- --remove
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const remove = process.argv.includes("--remove");
const shortcuts = [
  { name: "회의록", script: "launch.mjs", icon: "icon" },
  { name: "회의록 종료", script: "stop.mjs", icon: "icon-stop" }
];

function powershell(script) {
  // -EncodedCommand (UTF-16LE) keeps Korean names and paths intact on the way in.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdio: "inherit" });
}

const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;

function windows() {
  // The desktop path is resolved inside PowerShell (it follows OneDrive redirection) and never
  // read back: PowerShell 5.1 prints in the console code page, which would garble Korean paths.
  const lines = ["$ErrorActionPreference = 'Stop'", "[Console]::OutputEncoding = [Text.Encoding]::UTF8", "$desktop = [Environment]::GetFolderPath('Desktop')"];
  for (const item of shortcuts) {
    lines.push(`$path = Join-Path $desktop ${psQuote(`${item.name}.lnk`)}`);
    if (remove) { lines.push("if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }"); continue; }
    lines.push(
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($path)",
      `$s.TargetPath = ${psQuote(node)}`,
      `$s.Arguments = ${psQuote(`"${path.join(root, "scripts", item.script)}" --quiet`)}`,
      `$s.WorkingDirectory = ${psQuote(root)}`,
      `$s.IconLocation = ${psQuote(path.join(root, "assets", `${item.icon}.ico`))}`,
      "$s.WindowStyle = 7",
      `$s.Description = ${psQuote(item.name)}`,
      "$s.Save()",
      "Write-Output \"만들었습니다: $path\""
    );
  }
  powershell(lines.join("\n"));
}

function mac() {
  const desktop = path.join(os.homedir(), "Desktop");
  for (const item of shortcuts) {
    const app = path.join(desktop, `${item.name}.app`);
    fs.rmSync(app, { recursive: true, force: true });
    if (remove) continue;
    // A tiny AppleScript app; the browser (not this app) asks for microphone permission.
    const shell = `export PATH=${JSON.stringify(path.dirname(node))}:/usr/local/bin:/opt/homebrew/bin:$PATH; cd ${JSON.stringify(root)} && ${JSON.stringify(node)} scripts/${item.script} --quiet >/dev/null 2>&1`;
    execFileSync("osacompile", ["-o", app, "-e", `do shell script ${JSON.stringify(shell)}`]);
    const resources = path.join(app, "Contents", "Resources");
    fs.copyFileSync(path.join(root, "assets", `${item.icon}.icns`), path.join(resources, "applet.icns"));
    // Newer osacompile ships the default icon in Assets.car; drop it so applet.icns is used.
    fs.rmSync(path.join(resources, "Assets.car"), { force: true });
    try { execFileSync("plutil", ["-remove", "CFBundleIconName", path.join(app, "Contents", "Info.plist")], { stdio: "ignore" }); } catch { /* key absent */ }
    execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "ignore" }); // resources changed: re-sign ad hoc
    fs.utimesSync(app, new Date(), new Date()); // refresh Finder's icon cache
    console.log(`만들었습니다: ${app}`);
  }
}

function linux() {
  const desktop = (() => {
    try { return execFileSync("xdg-user-dir", ["DESKTOP"], { encoding: "utf8" }).trim(); } catch { return path.join(os.homedir(), "Desktop"); }
  })();
  for (const item of shortcuts) {
    const file = path.join(desktop, `${item.script === "launch.mjs" ? "meeting-notes" : "meeting-notes-stop"}.desktop`);
    if (remove) { fs.rmSync(file, { force: true }); continue; }
    fs.writeFileSync(file, [
      "[Desktop Entry]", "Type=Application", `Name=${item.name}`,
      `Exec="${node}" "${path.join(root, "scripts", item.script)}" --quiet`,
      `Path=${root}`, `Icon=${path.join(root, "assets", `${item.icon}.png`)}`, "Terminal=false", ""
    ].join("\n"), { mode: 0o755 });
    console.log(`만들었습니다: ${file}`);
  }
}

if (process.platform === "win32") windows();
else if (process.platform === "darwin") mac();
else linux();
if (remove) console.log("바탕화면 바로가기를 지웠습니다.");
else console.log("바탕화면의 ‘회의록’을 더블클릭하면 앱이 열립니다. 이 폴더를 옮기면 바로가기를 다시 만드세요 (npm run shortcut).");
