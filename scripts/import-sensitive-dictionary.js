const fs = require("fs");
const path = require("path");
const { parseCategories } = require("../server/sensitive");

const bundledFile = path.resolve(__dirname, "..", "server", "data", "default-sensitive-categories.json");
const activeFile = path.resolve(__dirname, "..", "server", "sensitive-words.json");
const categories = parseCategories(JSON.parse(fs.readFileSync(bundledFile, "utf8")));
const count = new Set(categories.flatMap((category) => category.words)).size;
fs.writeFileSync(activeFile, JSON.stringify({ categories }, null, 2));
console.log(`Imported ${count} unique sensitive words in ${categories.length} categories`);
