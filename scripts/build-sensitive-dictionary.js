const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { normalizeForMatch, parseWords } = require("../server/sensitive");

const sourceDir = path.resolve(__dirname, "..", "server", "data", "sensitive-sources");
const outputFile = path.resolve(__dirname, "..", "server", "data", "default-sensitive-words.txt");
const categoryOutputFile = path.resolve(__dirname, "..", "server", "data", "default-sensitive-categories.json");
const fullFiles = fs.readdirSync(sourceDir)
  .filter((file) => file.toLowerCase().endsWith(".txt"))
  .sort((left, right) => left.localeCompare(right, "zh-CN"));

function sourceTerms(file) {
  return fs.readFileSync(path.join(sourceDir, file), "utf8").split(/\r?\n/);
}

function cleanTerm(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\*+$/g, "")
    .trim();
}

function importable(value) {
  const normalized = normalizeForMatch(value);
  if (Array.from(normalized).length < 2 || Array.from(normalized).length > 40) return false;
  if (/^[a-z0-9]+$/i.test(normalized) && normalized.length < 4) return false;
  return true;
}

const categories = fullFiles.map((file) => ({
  id: `github-${crypto.createHash("sha1").update(file).digest("hex").slice(0, 12)}`,
  name: path.basename(file, path.extname(file)),
  words: parseWords(sourceTerms(file).map(cleanTerm).filter(importable))
}));
const words = parseWords(categories.flatMap((category) => category.words));
fs.writeFileSync(outputFile, `${words.join("\n")}\n`);
fs.writeFileSync(categoryOutputFile, JSON.stringify({ categories }, null, 2));
console.log(`Built ${words.length} unique words in ${categories.length} categories`);
