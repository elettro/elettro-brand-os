// Context builder for EPE AI tasks: assembles the Markdown guidance a task needs
// (per intelligence/manifest.json), with file hashes so every decision records
// exactly which intelligence version produced it. Missing required files fail loudly.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function defaultIntelligenceRoot() {
  // Packaged Lambda ships ./intelligence; the repo keeps it at the root.
  for (const candidate of [join(here, "intelligence"), join(here, "..", "..", "intelligence")]) {
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
  }
  throw new Error("Intelligence folder not found (expected ./intelligence with manifest.json)");
}

/** Split a Markdown file into its core (before the first bracketed heading) and `## [slug]` sections. */
export function splitSections(text, headingPattern) {
  const pattern = new RegExp(headingPattern);
  const lines = text.split(/\r?\n/);
  const sections = {};
  const core = [];
  let current = null;
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) {
      current = match[1];
      sections[current] = [line];
    } else if (current && /^## /.test(line)) {
      current = null;
      core.push(line);
    } else if (current) {
      sections[current].push(line);
    } else {
      core.push(line);
    }
  }
  return {
    core: core.join("\n").trim(),
    sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join("\n").trim()]))
  };
}

export const estimateTokens = (text) => Math.ceil(text.length / 4);

/**
 * Build guidance for one task. `vars` fills {brand}, {destination}; `sectors`
 * expands {sector} to each listed sector (a week call may span several).
 */
export function buildGuidance(task, { brand, destination, sectors = [] }, root = defaultIntelligenceRoot()) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const spec = manifest.tasks?.[task];
  if (!spec) throw new Error(`Unknown intelligence task: ${task}`);
  const fill = (s) => s.replaceAll("{brand}", brand).replaceAll("{destination}", destination || "");

  for (const required of manifest.requiredFiles || []) {
    if (!existsSync(join(root, fill(required)))) throw new Error(`Required intelligence file missing: ${fill(required)}`);
  }

  const optional = new Set(manifest.optionalSections || []);
  const files = new Map();
  const loadFile = (rel) => {
    if (!files.has(rel)) {
      const path = join(root, rel);
      if (!existsSync(path)) throw new Error(`Intelligence file missing: ${rel}`);
      const text = readFileSync(path, "utf8");
      files.set(rel, { text, hash: createHash("sha256").update(text).digest("hex").slice(0, 12), parts: splitSections(text, manifest.sectionHeadingPattern) });
    }
    return files.get(rel);
  };

  const blocks = [];
  const used = new Set();
  const expand = spec.files.flatMap((template) => template.includes("{sector}")
    ? sectors.map((s) => ({ template, entry: fill(template.replaceAll("{sector}", s)) }))
    : [{ template, entry: fill(template) }]);
  for (const { template, entry } of expand) {
    const [rel, section] = entry.split("#");
    const file = loadFile(rel);
    let text;
    if (!section) text = file.text.trim();
    else if (section === "core") text = file.parts.core;
    else if (file.parts.sections[section]) {
      // A section always travels with its file's core, once.
      text = used.has(`${rel}#core`) ? file.parts.sections[section] : `${file.parts.core}\n\n${file.parts.sections[section]}`;
      used.add(`${rel}#core`);
    } else if (optional.has(template)) {
      continue;
    } else {
      throw new Error(`Intelligence section missing: ${entry}`);
    }
    if (section === "core") {
      if (used.has(`${rel}#core`)) continue;
      used.add(`${rel}#core`);
    }
    blocks.push(`<<${entry}>>\n${text}`);
  }

  const guidance = blocks.join("\n\n");
  const tokens = estimateTokens(guidance);
  const budget = spec.maxGuidanceTokens || Infinity;
  if (tokens > budget) throw new Error(`Guidance for ${task} is ~${tokens} tokens, over its ${budget} budget`);
  const hashes = Object.fromEntries([...files].map(([rel, f]) => [rel, f.hash]));
  const intelligenceVersion = createHash("sha256").update(JSON.stringify(hashes)).digest("hex").slice(0, 12);
  return { task, guidance, tokens, hashes, intelligenceVersion };
}
