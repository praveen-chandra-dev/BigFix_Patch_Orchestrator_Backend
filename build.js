const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const run = (cmd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

const EXE_NAME = "BigFixPatchSetu-Backend.exe";
const DIST_DIR = "dist";
const NODE_EXE = process.execPath; // path to current node.exe

// 1. Clean
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true });
}
if (fs.existsSync("sea-prep.blob")) {
  fs.unlinkSync("sea-prep.blob");
}

// 2. Bundle with ncc
// -e open: the 'open' package (transitive dep of 'got') causes ncc to emit an async
// chunk (935.index.js) that can't be loaded inside a Node.js SEA. The backend never
// opens browser URLs, so excluding it is safe and eliminates the code-split.
console.log("\n=== Bundling with ncc ===");
run("npx ncc build main.js -o dist --minify -e open");

// 3. Generate the SEA blob
console.log("\n=== Generating SEA blob ===");
run("node --experimental-sea-config sea-config.json");

// 4. Copy node.exe as our target executable
console.log("\n=== Creating executable ===");
const outputExe = path.join(DIST_DIR, EXE_NAME);
fs.copyFileSync(NODE_EXE, outputExe);

// 5. Remove the signature from the copied exe (required on Windows)
try {
  run(`signtool remove /s "${outputExe}"`);
} catch {
  console.log("signtool not found or no signature to remove — continuing");
}

// 6. Inject the blob into the exe
console.log("\n=== Injecting SEA blob ===");
run(
  `npx postject "${outputExe}" NODE_SEA_BLOB sea-prep.blob ` +
  `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`
);

// 7. Clean up blob
fs.unlinkSync("sea-prep.blob");

console.log(`\n=== Done! Executable at: ${outputExe} ===`);