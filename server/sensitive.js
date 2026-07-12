const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_WORDS = [
  "出售枪支", "购买枪支", "出售毒品", "购买毒品", "代开发票",
  "办理假证", "出售银行卡", "收购银行卡", "提供色情服务", "招嫖",
  "赌博平台", "博彩平台", "洗钱通道", "买卖人体器官", "儿童色情"
];
const MAX_SENSITIVE_WORDS = 100000;
const MAX_SENSITIVE_CATEGORIES = 100;
const BUNDLED_CATEGORIES_FILE = path.resolve(__dirname, "data", "default-sensitive-categories.json");

function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s._\-·•|/\\]+/g, "");
}

function parseWords(input) {
  const rawValues = Array.isArray(input) ? input : [input];
  const values = rawValues.flatMap((value) => String(value || "").split(/[|;；\r\n]+/));
  const unique = new Map();
  for (const value of values) {
    const word = String(value || "").normalize("NFKC").trim().slice(0, 80);
    const key = normalizeForMatch(word);
    if (key && !unique.has(key)) unique.set(key, word);
    if (unique.size >= MAX_SENSITIVE_WORDS) break;
  }
  return Array.from(unique.values());
}

function categoryId(value, name, index) {
  const clean = String(value || "").trim().slice(0, 80);
  if (/^[a-zA-Z0-9:_-]+$/.test(clean)) return clean;
  const hash = crypto.createHash("sha1").update(`${name}:${index}`).digest("hex").slice(0, 12);
  return `category-${hash}`;
}

function parseCategories(input, fallbackName = "自定义词库") {
  let rawCategories = [];
  if (Array.isArray(input)) rawCategories = input;
  else if (Array.isArray(input?.categories)) rawCategories = input.categories;
  else rawCategories = [{ name: fallbackName, words: input?.words ?? input ?? [] }];

  const ids = new Set();
  return rawCategories.slice(0, MAX_SENSITIVE_CATEGORIES).map((item, index) => {
    const name = String(item?.name || `${fallbackName}${index + 1}`).normalize("NFKC").trim().slice(0, 40) || `${fallbackName}${index + 1}`;
    let id = categoryId(item?.id, name, index);
    while (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    return { id, name, words: parseWords(item?.words ?? item?.text ?? []) };
  });
}

function loadBundledCategories() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BUNDLED_CATEGORIES_FILE, "utf8"));
    const categories = parseCategories(parsed);
    if (categories.some((category) => category.words.length > 0)) return categories;
  } catch {
    // The small built-in list keeps first-run moderation available.
  }
  return parseCategories([{ id: "built-in", name: "默认词库", words: DEFAULT_WORDS }]);
}

function flattenWords(categories) {
  return parseWords(categories.flatMap((category) => category.words));
}

function buildTrie(words) {
  const root = Object.create(null);
  for (const word of words) {
    const normalized = normalizeForMatch(word);
    if (!normalized) continue;
    let node = root;
    for (const character of normalized) {
      node[character] ||= Object.create(null);
      node = node[character];
    }
    node.$ = true;
  }
  return root;
}

function passwordMatches(actual, expected) {
  if (!String(expected || "")) return false;
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function publicCategories(categories) {
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    words: category.words.slice(),
    text: category.words.join(";")
  }));
}

function createSensitiveFilter(options = {}) {
  const file = options.file || path.resolve(process.env.SENSITIVE_WORDS_FILE || path.resolve(__dirname, "sensitive-words.json"));
  const password = String(options.password || process.env.SENSITIVE_ADMIN_PASSWORD || "");
  const persist = options.persist !== false;
  let categories = options.defaultCategories
    ? parseCategories(options.defaultCategories)
    : options.defaultWords
      ? parseCategories([{ id: "test-default", name: "测试词库", words: options.defaultWords }])
      : loadBundledCategories();

  if (persist) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      categories = parseCategories(parsed, "原有词库");
    } catch {
      fs.writeFileSync(file, JSON.stringify({ categories }, null, 2));
    }
  }

  let words = flattenWords(categories);
  let trie = buildTrie(words);

  const save = () => {
    if (!persist) return;
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ categories }, null, 2));
    fs.renameSync(temporary, file);
  };

  const result = () => ({
    ok: true,
    count: words.length,
    categories: publicCategories(categories)
  });

  return {
    contains(value) {
      const normalized = normalizeForMatch(value);
      if (!normalized) return false;
      for (let start = 0; start < normalized.length; start += 1) {
        let node = trie;
        for (let index = start; index < normalized.length; index += 1) {
          node = node[normalized[index]];
          if (!node) break;
          if (node.$) return true;
        }
      }
      return false;
    },
    list(adminPassword) {
      if (!passwordMatches(adminPassword, password)) return { ok: false, error: "invalid-password" };
      return result();
    },
    update(adminPassword, input) {
      if (!passwordMatches(adminPassword, password)) return { ok: false, error: "invalid-password" };
      categories = parseCategories(input, "自定义词库");
      words = flattenWords(categories);
      trie = buildTrie(words);
      save();
      return result();
    },
    snapshot() {
      return words.slice();
    },
    categorySnapshot() {
      return publicCategories(categories);
    }
  };
}

module.exports = { createSensitiveFilter, normalizeForMatch, parseWords, parseCategories };
