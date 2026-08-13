import { mkdir, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";

const owner = process.env.GITHUB_REPOSITORY_OWNER || "Chris1Wang3";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const outputDir = path.resolve(process.env.OUTPUT_DIR || "dist");

if (!token) {
  throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "profile-card-generator",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function requestJson(url, options = {}) {
  const body = options.body || null;
  const requestHeaders = { ...headers, ...options.headers };
  if (body) requestHeaders["Content-Length"] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: options.method || "GET",
        headers: requestHeaders,
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`${status} ${response.statusMessage || "Request failed"}: ${url}`));
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`Invalid JSON returned by ${url}`, { cause: error }));
          }
        });
      },
    );

    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function fetchAllRepos() {
  const repos = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await requestJson(
      `https://api.github.com/users/${owner}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
    );
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

async function fetchContributionCalendar() {
  const data = await requestJson("https://api.github.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($login: String!) {
        user(login: $login) {
          contributionsCollection {
            contributionCalendar {
              totalContributions
              weeks { contributionDays { date contributionCount } }
            }
          }
        }
      }`,
      variables: { login: owner },
    }),
  });

  if (data.errors?.length) {
    throw new Error(data.errors.map((error) => error.message).join("; "));
  }

  return data.data.user.contributionsCollection.contributionCalendar;
}

async function fetchLanguages(repos) {
  const totals = new Map();
  const sourceRepos = repos.filter(
    (repo) => !repo.fork && !repo.archived && repo.name.toLowerCase() !== owner.toLowerCase(),
  );

  for (const repo of sourceRepos) {
    const languages = await requestJson(repo.languages_url);
    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) || 0) + bytes);
    }
  }

  const totalBytes = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([language, bytes]) => ({
      language,
      percentage: totalBytes ? (bytes / totalBytes) * 100 : 0,
    }));
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cardShell(title, content, description) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1220"/>
      <stop offset="1" stop-color="#111c2d"/>
    </linearGradient>
    <style>
      .title { font: 600 16px "Segoe UI", "Microsoft YaHei", sans-serif; }
      .label { font: 500 12px "Segoe UI", "Microsoft YaHei", sans-serif; }
      .value { font: 700 24px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .mono { font: 600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    </style>
  </defs>
  <rect x="1" y="1" width="493" height="193" rx="12" fill="url(#bg)" stroke="#253249"/>
  <rect x="18" y="20" width="3" height="18" rx="1.5" fill="#8dd3a8"/>
  <text x="31" y="35" class="title" fill="#f3f7f5">${escapeXml(title)}</text>
  ${content}
</svg>`;
}

function renderStats(stats, locale) {
  const copy = locale === "zh"
    ? {
        title: "GitHub 公开数据",
        description: `${owner} 的公开仓库、获赞、关注者和近一年贡献数据。`,
        labels: ["公开仓库", "项目获赞", "关注者", "近一年贡献"],
      }
    : {
        title: "GitHub public stats",
        description: `Public repositories, stars, followers, and yearly contributions for ${owner}.`,
        labels: ["Public repos", "Stars earned", "Followers", "Yearly contributions"],
      };

  const values = [stats.publicRepos, stats.stars, stats.followers, stats.contributions];
  const positions = [
    { x: 31, y: 82 },
    { x: 267, y: 82 },
    { x: 31, y: 146 },
    { x: 267, y: 146 },
  ];

  const content = positions
    .map(
      ({ x, y }, index) => `<g>
    <text x="${x}" y="${y - 19}" class="label" fill="#8b9bae">${escapeXml(copy.labels[index])}</text>
    <text x="${x}" y="${y + 10}" class="value" fill="#8dd3a8">${escapeXml(values[index])}</text>
  </g>`,
    )
    .join("\n  ");

  return cardShell(copy.title, content, copy.description);
}

function renderLanguages(languages, locale) {
  const copy = locale === "zh"
    ? {
        title: "公开项目语言占比",
        description: `${owner} 的公开项目按代码字节计算的语言分布。`,
        empty: "暂无语言数据",
      }
    : {
        title: "Languages in public projects",
        description: `Language distribution by code bytes across ${owner}'s public projects.`,
        empty: "No language data",
      };

  const colors = ["#8dd3a8", "#74b98f", "#5c9f77", "#477f61", "#35614a"];
  const content = languages.length
    ? languages
        .map((item, index) => {
          const y = 63 + index * 27;
          const barWidth = Math.max(3, Math.round((item.percentage / 100) * 248));
          return `<g>
    <text x="31" y="${y}" class="label" fill="#cbd5e1">${escapeXml(item.language)}</text>
    <text x="463" y="${y}" text-anchor="end" class="mono" fill="#8b9bae">${item.percentage.toFixed(1)}%</text>
    <rect x="154" y="${y - 9}" width="248" height="7" rx="3.5" fill="#1d2a3c"/>
    <rect x="154" y="${y - 9}" width="${barWidth}" height="7" rx="3.5" fill="${colors[index]}"/>
  </g>`;
        })
        .join("\n  ")
    : `<text x="31" y="90" class="label" fill="#8b9bae">${escapeXml(copy.empty)}</text>`;

  return cardShell(copy.title, content, copy.description);
}

function calculateStreaks(calendar) {
  const days = calendar.weeks.flatMap((week) => week.contributionDays);
  let current = 0;
  let longest = 0;
  let running = 0;

  for (const day of days) {
    if (day.contributionCount > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (days[index].contributionCount > 0) current += 1;
    else break;
  }

  return { current, longest, total: calendar.totalContributions };
}

function renderStreak(streaks, locale) {
  const copy = locale === "zh"
    ? {
        title: "GitHub 贡献记录",
        description: `${owner} 近一年的 GitHub 贡献与连续贡献数据。`,
        labels: ["当前连续", "最长连续", "近一年贡献"],
        suffix: "天",
      }
    : {
        title: "GitHub contribution streak",
        description: `GitHub contribution and streak data for ${owner} over the past year.`,
        labels: ["Current streak", "Longest streak", "Yearly contributions"],
        suffix: " days",
      };
  const values = [`${streaks.current}${copy.suffix}`, `${streaks.longest}${copy.suffix}`, String(streaks.total)];
  const positions = [31, 186, 341];
  const content = positions.map((x, index) => `<g>
    <text x="${x}" y="77" class="label" fill="#8b9bae">${escapeXml(copy.labels[index])}</text>
    <text x="${x}" y="113" class="value" fill="#8dd3a8">${escapeXml(values[index])}</text>
  </g>`).join("\n  ");

  return cardShell(copy.title, content, copy.description);
}

const [user, repos, calendar] = await Promise.all([
  requestJson(`https://api.github.com/users/${owner}`),
  fetchAllRepos(),
  fetchContributionCalendar(),
]);

const languages = await fetchLanguages(repos);
const stats = {
  publicRepos: user.public_repos,
  stars: repos.reduce((sum, repo) => sum + repo.stargazers_count, 0),
  followers: user.followers,
  contributions: calendar.totalContributions,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDir, "stats-zh.svg"), renderStats(stats, "zh"), "utf8"),
  writeFile(path.join(outputDir, "stats-en.svg"), renderStats(stats, "en"), "utf8"),
  writeFile(path.join(outputDir, "languages-zh.svg"), renderLanguages(languages, "zh"), "utf8"),
  writeFile(path.join(outputDir, "languages-en.svg"), renderLanguages(languages, "en"), "utf8"),
  writeFile(path.join(outputDir, "streak-zh.svg"), renderStreak(calculateStreaks(calendar), "zh"), "utf8"),
  writeFile(path.join(outputDir, "streak-en.svg"), renderStreak(calculateStreaks(calendar), "en"), "utf8"),
]);

console.log(`Generated profile cards for ${owner} in ${outputDir}`);
