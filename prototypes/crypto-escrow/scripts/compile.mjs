import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

export const root = fileURLToPath(new URL("../", import.meta.url));
let cached;
export function compileContracts() {
  if (cached) return cached;
  const sources = {};
  for (const name of fs.readdirSync(path.join(root, "contracts"))) {
    if (name.endsWith(".sol")) sources[name] = { content: fs.readFileSync(path.join(root, "contracts", name), "utf8") };
  }
  const input = {
    language: "Solidity", sources,
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (name) => {
    const base = path.resolve(root, "node_modules");
    const target = path.resolve(base, name);
    if (!target.startsWith(base + path.sep)) return { error: "Import outside dependencies" };
    try { return { contents: fs.readFileSync(target, "utf8") }; }
    catch { return { error: `Missing import: ${name}` }; }
  } }));
  const errors = (output.errors || []).filter(e => e.severity === "error");
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join("\n"));
  cached = {};
  for (const contracts of Object.values(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      if (c.evm.bytecode.object) cached[name] = {
        contractName: name, compiler: solc.version(), abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
        deployedBytecode: "0x" + c.evm.deployedBytecode.object,
        testNetworksOnly: [31337, 11155111]
      };
    }
  }
  return cached;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  for (const [name, artifact] of Object.entries(compileContracts())) {
    fs.writeFileSync(path.join(root, "artifacts", name + ".json"), JSON.stringify(artifact, null, 2) + "\n");
  }
  console.log(`Compiled with ${solc.version()}; mainnet deployment is disabled.`);
}
