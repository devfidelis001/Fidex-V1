// Checks that the Node/Electron side of FIDEX AI is healthy.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

const major = parseInt(process.versions.node.split(".")[0], 10);
check("Node.js >= 18", major >= 18, process.version);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
check("package.json name is fidex-ai", pkg.name === "fidex-ai", pkg.name);

let electronVersion = "";
try {
  electronVersion = require(path.join(root, "node_modules", "electron", "package.json")).version;
} catch (e) {}
check("Electron installed", !!electronVersion, electronVersion || "not installed");

for (const dir of ["src/main", "src/preload", "src/renderer", "backend/app", "data/db", "docs", "scripts", "assets/icons"]) {
  check(`folder ${dir}`, fs.existsSync(path.join(root, dir)));
}

for (const f of ["src/renderer/overlay.html", "src/renderer/welcome.css", "src/renderer/home.css"]) check(`file ${f}`, fs.existsSync(path.join(root, f)));
check("Windows app icon (assets/icons/icon.ico)", fs.existsSync(path.join(root, "assets", "icons", "icon.ico")));

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
