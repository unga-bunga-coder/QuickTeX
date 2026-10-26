// Builds the site in dist/: index.html (CodeMirror bundle, core, store and app inlined), MathJax, fonts,
// manifest, icons, THIRD_PARTY_LICENSES.txt, and a service worker whose cache name is a hash of everything it caches.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const vendor = await build({ entryPoints: ["src/vendor.js"], bundle: true, minify: true, format: "iife",
              globalName: "CM", outfile: "build/vendor.js", logLevel: "warning", metafile: true });

rmSync("dist", { recursive: true, force: true });
for (const d of ["dist/fonts", "dist/icons"]) mkdirSync(d, { recursive: true });
const shell = [];                                   // files the service worker caches, relative to the site root
const copy = (from, to) => { copyFileSync(from, "dist/" + to); shell.push(to) };
const write = (to, text) => { writeFileSync("dist/" + to, text); shell.push(to) };

// Fonts: fontsource's @font-face rules (all subsets, as Google Fonts serves them), woff2 only.
const FONTS = ["jetbrains-mono/400", "jetbrains-mono/600", "stix-two-text/400", "stix-two-text/600", "stix-two-text/400-italic"];
const fontCss = FONTS.map(f => readFileSync(`node_modules/@fontsource/${f}.css`, "utf8").replace(
  /url\(\.\/files\/([\w-]+\.woff2)\) format\('woff2'\), url\([^)]*\) format\('woff'\)/g,
  (_, w) => { copy(`node_modules/@fontsource/${f.split("/")[0]}/files/${w}`, "fonts/" + w); return `url(fonts/${w}) format('woff2')` })).join("\n");
if (fontCss.includes("./files/")) throw new Error("unexpected fontsource CSS format");

copy("node_modules/mathjax/es5/tex-svg-full.js", "mathjax.js");
for (const f of readdirSync("src/icons").filter(f => f.endsWith(".png"))) copy("src/icons/" + f, "icons/" + f);

// Theme colours come from the CSS tokens: header chrome for the theme, paper for the splash.
const page = readFileSync("src/page.html", "utf8");
const token = name => [...page.matchAll(new RegExp(`--${name}:(#[0-9a-f]{6})`, "gi"))].map(m => m[1]);   // [light, dark, dark]
write("manifest.webmanifest", JSON.stringify({
  name: "QuickTeX", short_name: "QuickTeX", description: "A LaTeX maths notebook with live preview.",
  start_url: "./", scope: "./", display: "standalone",
  theme_color: token("chrome")[0], background_color: token("paper")[0],
  icons: [
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
}, null, 2));

const read = p => readFileSync(p, "utf8").replace(/<\/script/gi, "<\\/script");
const html = page
  .replace("%CHROME%", token("chrome")[0]).replace("%CHROME_DARK%", token("chrome")[1])
  .replace("/*FONTS*/", () => fontCss)
  .replace("/*VENDOR*/", () => read("build/vendor.js"))
  .replace("/*CORE*/", () => read("src/core.js"))
  .replace("/*STORE*/", () => read("src/store.js"))
  .replace("/*APP*/", () => read("src/app.js"));
writeFileSync("dist/index.html", html);
shell.unshift("./");

// Licence notices for everything the site redistributes: each package esbuild bundled, MathJax and the fonts.
const pkgs = new Set(Object.keys(vendor.metafile.inputs).map(f => f.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
for (const p of ["mathjax", "@fontsource/jetbrains-mono", "@fontsource/stix-two-text"]) pkgs.add(p);
const notices = [...pkgs].sort().map(p => {
  const dir = "node_modules/" + p, file = readdirSync(dir).find(f => /^licen[cs]e/i.test(f));
  if (!file) throw new Error("no licence file in " + p);
  const title = `${p} ${JSON.parse(readFileSync(dir + "/package.json", "utf8")).version}`;
  return `${title}\n${"=".repeat(title.length)}\n\n${readFileSync(dir + "/" + file, "utf8").trim()}`;
});
writeFileSync("dist/THIRD_PARTY_LICENSES.txt",
  "QuickTeX redistributes the following open source software. Their licence notices follow.\n\n\n" + notices.join("\n\n\n") + "\n");

const hash = createHash("sha256");
for (const f of shell) hash.update(f).update(readFileSync("dist/" + (f === "./" ? "index.html" : f)));
const version = hash.digest("hex").slice(0, 12);
writeFileSync("dist/sw.js", `const VERSION=${JSON.stringify(version)};\nconst FILES=${JSON.stringify(shell)};\n` + readFileSync("src/sw.js", "utf8"));

console.log(`dist/  ${shell.length} cached files, index.html ${(html.length / 1024).toFixed(0)} KB, version ${version}`);
