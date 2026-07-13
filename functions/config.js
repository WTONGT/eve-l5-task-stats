/**
 * EVE 五级任务报酬统计 — 后端 API（Netlify Functions v2）
 *
 * ================ 部署要求 ================
 *   - Netlify Functions v2（export default 语法）
 *   - Netlify Blobs store: "config"（部署时在 UI 中启用 Blobs）
 *   - 环境变量：
 *       ADMIN_PASS  价格配置页口令
 *       BOSS_PASS   老板登记页口令
 *
 * ================ 存储架构 ================
 * Netlify Blobs store: "config"
 *   boss-data/{name}  老板声望号数组    eg. ["Rick Greyman", "Mango TT"]
 *   bosses            老板名索引数组    eg. ["赵六", "小明"]
 *   prices            价格配置对象      { taskPrices, keyMap, keyMapOrder, taskPriceOrder }
 *   _version          全局版本号        递增计数器，用于增量同步 + 乐观锁
 *
 * ================ API 接口 ================
 *   GET  /?v=N        版本未变返回 {unchanged:true}，否则返回完整配置
 *   POST /            三种写入模式（见 handlePost 分支）
 *
 * ================ 鉴权机制 ================
 *   老板增删改   请求头 x-boss-pass  ↔ 环境变量 BOSS_PASS
 *   价格配置     请求头 x-admin-pass ↔ 环境变量 ADMIN_PASS
 *   环境变量未设置时，对应接口一律拒绝
 *
 * ================ 并发说明（重要）============
 *   Netlify Blobs 是最终一致性 KV 存储，不支持原子 CAS / 事务。
 *   乐观锁（expectV）采用 "先校验再写入" 模式，存在极小概率
 *   check-then-act 竞态窗口。小团队（<10 人同时编辑）场景可忽略。
 *   冲突时前端提示："数据已被他人修改，请刷新后重试"。
 */
import { getStore } from "@netlify/blobs";

// Blob key 前缀/常量
const BOSS_PREFIX  = "boss-data/";   // 老板数据前缀
const PRICES_KEY   = "prices";       // 价格配置 key
const BOSSES_INDEX = "bosses";       // 老板名索引 key
const VERSION_KEY  = "_version";     // 全局版本号 key

// --------------- 默认配置（首次部署 / Blobs 为空时使用） ---------------

const DEFAULT_PRICES = {
  taskPrices: {
    "繁殖设施": 15, "天使的愤怒": 20, "净化的火焰": 20, "开拓号": 20,
    "清理门户": 20, "地平线上的萨沙": 20, "灭龙行动": 20, "萨沙取物": 20,
    "自由间谍": 25, "重重一螫": 25, "聚集力量": 25, "巨型驱动器": 25,
    "解放矿工A": 25, "解放矿工C": 25, "袭击护航队A": 35, "袭击护航队C": 40,
    "地点地点": 25, "斩龙行动": 0, "荣誉目标": 0
  },
  keyMap: {
    "繁殖": "繁殖设施", "设施": "繁殖设施",
    "天使": "天使的愤怒", "愤怒": "天使的愤怒",
    "净化": "净化的火焰", "火焰": "净化的火焰",
    "开拓": "开拓号",
    "清理": "清理门户", "门户": "清理门户",
    "地平": "地平线上的萨沙", "地平线": "地平线上的萨沙",
    "灭龙": "灭龙行动",
    "萨沙": "萨沙取物", "取物": "萨沙取物",
    "自由": "自由间谍", "间谍": "自由间谍",
    "重重": "重重一螫",
    "聚集": "聚集力量", "力量": "聚集力量",
    "巨型": "巨型驱动器", "驱动器": "巨型驱动器", "巨驱": "巨型驱动器",
    "解放矿工a": "解放矿工A", "解放矿工A": "解放矿工A",
    "解放矿工c": "解放矿工C", "解放矿工C": "解放矿工C", "解放矿工目标C": "解放矿工C",
    "解放矿工": "解放矿工A", "解放A": "解放矿工A", "解放a": "解放矿工A",
    "矿工A": "解放矿工A", "矿工a": "解放矿工A",
    "解放C": "解放矿工C", "解放c": "解放矿工C",
    "矿工C": "解放矿工C", "矿工c": "解放矿工C",
    "解放": "解放矿工A", "矿工": "解放矿工A",
    "袭击护航队a": "袭击护航队A", "袭击护航队A": "袭击护航队A", "袭击护航A": "袭击护航队A",
    "袭击护航队c": "袭击护航队C", "袭击护航队C": "袭击护航队C", "袭击护航队目标C": "袭击护航队C",
    "袭击护航C": "袭击护航队C", "袭击护航队": "袭击护航队A",
    "袭击护航": "袭击护航队A",
    "护航队A": "袭击护航队A", "护航队a": "袭击护航队A",
    "袭击A": "袭击护航队A", "袭击a": "袭击护航队A",
    "护航队C": "袭击护航队C", "护航队c": "袭击护航队C",
    "袭击C": "袭击护航队C", "袭击c": "袭击护航队C",
    "护航队": "袭击护航队A", "袭击": "袭击护航队A", "护航": "袭击护航队A",
    "地点": "地点地点",
    "斩龙": "斩龙行动",
    "荣誉目标": "荣誉目标"
  },
  keyMapOrder: ["袭击护航队目标C","解放矿工目标C","繁殖","设施","天使","愤怒","净化","火焰","开拓","清理","门户","地平","地平线","灭龙","萨沙","取物","自由","间谍","重重","聚集","力量","巨型","驱动器","巨驱","解放矿工a","解放矿工A","解放矿工c","解放矿工C","解放矿工","解放A","解放a","矿工A","矿工a","解放C","解放c","矿工C","矿工c","解放","矿工","袭击护航队a","袭击护航队A","袭击护航A","袭击护航队c","袭击护航队C","袭击护航C","袭击护航队","袭击护航","护航队A","护航队a","袭击A","袭击a","护航队C","护航队c","袭击C","袭击c","护航队","袭击","护航","地点","斩龙","荣誉目标"],
  taskPriceOrder: ["繁殖设施","天使的愤怒","净化的火焰","开拓号","清理门户","地平线上的萨沙","灭龙行动","萨沙取物","自由间谍","重重一螫","聚集力量","巨型驱动器","解放矿工A","解放矿工C","袭击护航队A","袭击护航队C","地点地点","斩龙行动","荣誉目标"]
};

// 生成 CORS 响应头：动态反射 Origin，比 * 更安全
// 同时支持同源调用和自定义域名（用户通过 localStorage 配置 API 地址的场景）
function getCorsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-pass, x-boss-pass",
    "Vary": "Origin"
  };
}

// ---------- 工具函数 ----------

// 统一 JSON 响应（带 CORS 头）
// corsHeaders 由调用方传入，支持动态 Origin 反射
function json(body, status = 200, corsHeaders = defaultCorsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// 默认 CORS 头（兜底用，正常走 getCorsHeaders 动态生成）
const defaultCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-pass, x-boss-pass"
};

/**
 * 口令校验
 * @param {Request} request     请求对象
 * @param {string}  headerName  请求头名
 * @param {string}  envName     环境变量名
 * @returns {boolean}           校验是否通过
 *
 * 规则：环境变量未设置时一律拒绝（防止空口令放行）
 */
function checkPass(request, headerName, envName) {
  const expected = process.env[envName];
  if (!expected) return false;
  const provided = request.headers.get(headerName) || "";
  return provided === expected;
}

// 价格配置页鉴权
function checkAdminPass(request) {
  return checkPass(request, "x-admin-pass", "ADMIN_PASS");
}

// 老板登记页鉴权
function checkBossPass(request) {
  return checkPass(request, "x-boss-pass", "BOSS_PASS");
}

/**
 * 乐观锁校验
 * @param {object} store  Blob store 对象
 * @param {object} body   请求体（含 expectV）
 * @returns {object}      { ok: boolean, v: number, error?: string }
 *
 * 规则：expectV 缺失或不匹配均视为冲突，返回当前版本号
 * 优化：只读一次版本号，避免重复 Blob 读取
 */
async function checkExpectV(store, body) {
  const curVer = await getVersion(store);
  if (body.expectV === undefined) {
    return { ok: false, v: curVer, error: "缺少版本号参数" };
  }
  if (parseInt(body.expectV, 10) !== curVer) {
    return { ok: false, v: curVer };
  }
  return { ok: true };
}

/**
 * 老板名校验（防路径遍历）
 * 规则：非空、≤32 字符、不含斜杠
 * 原因：斜杠会破坏 boss-data/ 前缀结构，导致路径遍历风险
 */
function validateBossName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 32 && !name.includes("/");
}

/**
 * 声望号名校验
 * 规则：非空、≤32 字符、不含斜杠
 */
function validatePublisherId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 32 && !id.includes("/");
}

/**
 * 价格配置校验
 * @param {object} taskPrices   任务价目表
 * @param {object} keyMap       识别词映射
 * @returns {object|null}       校验失败返回 {error}，成功返回 null
 *
 * 规则：
 *   - taskPrices: key ≤64字、value 是数字、总数 ≤200 条
 *   - keyMap: key ≤64字、value ≤64字、总数 ≤200 条
 *   - 所有 key 不能含斜杠
 */
function validatePricesConfig(taskPrices, keyMap) {
  if (typeof taskPrices !== "object" || taskPrices === null) {
    return { error: "taskPrices 格式错误" };
  }
  if (typeof keyMap !== "object" || keyMap === null) {
    return { error: "keyMap 格式错误" };
  }

  const tpKeys = Object.keys(taskPrices);
  const kmKeys = Object.keys(keyMap);

  if (tpKeys.length > 200) return { error: "任务价目数量超限（最多200条）" };
  if (kmKeys.length > 200) return { error: "识别词数量超限（最多200条）" };

  for (const k of tpKeys) {
    if (k.length === 0 || k.length > 64) return { error: "任务名长度不合法（1-64字符）" };
    if (k.includes("/")) return { error: "任务名不能包含斜杠" };
    if (typeof taskPrices[k] !== "number" || isNaN(taskPrices[k])) {
      return { error: "任务价格必须是数字" };
    }
  }

  for (const k of kmKeys) {
    if (k.length === 0 || k.length > 64) return { error: "识别词长度不合法（1-64字符）" };
    if (k.includes("/")) return { error: "识别词不能包含斜杠" };
    const v = keyMap[k];
    if (typeof v !== "string" || v.length === 0 || v.length > 64) {
      return { error: "目标任务名长度不合法（1-64字符）" };
    }
    if (v.includes("/")) return { error: "目标任务名不能包含斜杠" };
  }

  return null;
}

// ---------- Functions v2 入口 ----------

export default async (request, context) => {
  const corsHeaders = getCorsHeaders(request);

  // 预检请求：CORS 握手
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // getStore 须在请求函数内调用，Blobs 环境变量才会被注入
  const store = getStore("config");

  if (request.method === "GET")  return handleGet(store, request, corsHeaders);
  if (request.method === "POST") return handlePost(store, request, corsHeaders);

  return json({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
};

// ---------- GET: 聚合全量配置 ----------

/**
 * 首次部署初始化
 * 检测 Blobs 为空时，写入默认配置 + 初始化版本号为 1
 * 确保后续 POST 的乐观锁有正确的基准版本
 *
 * 写入顺序：先写数据，最后写版本号（版本号=1 表示"初始化已完成"）
 * 这样即使中途失败，下次检测到 ver===0 会重新初始化，不会出现
 * 版本号已更新但数据为空的情况。
 *
 * 竞态说明：极端情况下两个并发请求可能都判断 ver===0 并同时初始化，
 * 但数据内容相同，重复写入不影响正确性，版本号最终也是 1。
 *
 * @returns {boolean} 是否执行了初始化
 */
async function ensureInitialized(store) {
  const ver = await getVersion(store);
  if (ver > 0) return false;

  // 先写数据（价格配置 + 老板索引）
  await store.set(PRICES_KEY, JSON.stringify(DEFAULT_PRICES));
  await store.set(BOSSES_INDEX, JSON.stringify([]));

  // 最后写版本号（标记初始化完成）
  await store.set(VERSION_KEY, "1");

  return true;
}

/**
 * GET 请求处理
 * 流程：初始化检查 → 版本比对 → 版本未变则 304 式返回 → 版本变更则聚合全量数据
 * 数据聚合：老板索引 → 逐个读老板数据 + 价格配置 → 合并返回
 * 错误兜底：失败时返回默认配置（保证页面可用）
 */
async function handleGet(store, request, corsHeaders) {
  try {
    const url = new URL(request.url);
    const clientVer = parseInt(url.searchParams.get("v"), 10) || 0;

    // 首次部署初始化
    await ensureInitialized(store);

    const serverVer = await getVersion(store);

    // 版本未变：返回 unchanged，前端复用本地缓存（省流量）
    if (clientVer > 0 && clientVer === serverVer) {
      return json({ unchanged: true, v: serverVer }, 200, corsHeaders);
    }

    // 聚合所有老板数据（按索引逐个读取）
    const bosses = {};
    const indexRaw = await store.get(BOSSES_INDEX);
    const bossNames = indexRaw ? JSON.parse(indexRaw) : [];
    for (const name of bossNames) {
      try {
        const raw = await store.get(BOSS_PREFIX + name);
        if (raw) bosses[name] = JSON.parse(raw);
      } catch (e) {
        console.error("load boss data failed:", name, e);
      }
    }

    // 读取价格配置
    const pricesRaw = await store.get(PRICES_KEY);
    const prices = pricesRaw ? JSON.parse(pricesRaw) : DEFAULT_PRICES;

    return json({ v: serverVer, bosses, ...prices }, 200, corsHeaders);
  } catch (e) {
    console.error("handleGet error:", e);
    // 兜底：返回默认配置，保证页面能渲染
    return json({ v: 0, bosses: {}, ...DEFAULT_PRICES }, 200, corsHeaders);
  }
}

// ---------- POST: 写入配置（三种模式） ----------

/**
 * POST 请求处理（三种写入模式，按 body 字段自动识别）
 *
 * 模式 1：保存老板数据
 *   body: { name, ids, expectV, oldName? }
 *   oldName 用于重命名场景，服务端用它清理旧 Blob + 索引
 *
 * 模式 2：删除老板
 *   body: { remove, expectV }
 *
 * 模式 3：保存价格配置
 *   body: { taskPrices, keyMap, keyMapOrder, taskPriceOrder, expectV }
 *
 * 通用：
 *   - 鉴权失败 → 403
 *   - 版本冲突 → 409
 *   - 参数错误 → 400
 */
async function handlePost(store, request, corsHeaders) {
  try {
    const body = JSON.parse(await request.text());
    // 局部包装：自动带上 corsHeaders
    const resp = (data, status) => json(data, status, corsHeaders);

    // ===== 模式 1：保存老板数据 =====
    if (body.name && Array.isArray(body.ids)) {
      if (!checkBossPass(request)) {
        return resp({ ok: false, error: "口令错误" }, 403);
      }
      if (!validateBossName(body.name)) {
        return resp({ ok: false, error: "老板名不合法（1-32字符，不含斜杠）" }, 400);
      }
      if (body.ids.length > 100) {
        return resp({ ok: false, error: "声望号数量超限（最多100个）" }, 400);
      }
      // 校验每个声望号名字
      for (const id of body.ids) {
        if (!validatePublisherId(id)) {
          return resp({ ok: false, error: "声望号名字不合法（1-32字符，不含斜杠）" }, 400);
        }
      }

      // 乐观锁校验
      const vCheck = await checkExpectV(store, body);
      if (!vCheck.ok) {
        return resp({ ok: false, conflict: true, v: vCheck.v, error: vCheck.error || "数据已被他人修改，请刷新后重试" }, 409);
      }

      // 写入老板数据
      await store.set(BOSS_PREFIX + body.name, JSON.stringify(body.ids));

      // 维护老板名索引
      const indexRaw = await store.get(BOSSES_INDEX);
      const index = indexRaw ? JSON.parse(indexRaw) : [];

      // 重命名场景：清理旧 Blob + 旧索引
      if (body.oldName && body.oldName !== body.name) {
        if (!validateBossName(body.oldName)) {
          return resp({ ok: false, error: "旧老板名不合法" }, 400);
        }
        const oldIdx = index.indexOf(body.oldName);
        if (oldIdx !== -1) index.splice(oldIdx, 1);
        try { await store.delete(BOSS_PREFIX + body.oldName); } catch (e) { console.error("delete old boss blob failed:", e); }
      }

      // 新名字加入索引（去重）
      if (index.indexOf(body.name) === -1) index.push(body.name);
      await store.set(BOSSES_INDEX, JSON.stringify(index));

      const newV = await bumpVersion(store);
      return resp({ ok: true, saved: body.name, v: newV });
    }

    // ===== 模式 2：删除老板 =====
    if (body.remove && typeof body.remove === "string") {
      if (!checkBossPass(request)) {
        return resp({ ok: false, error: "口令错误" }, 403);
      }
      if (!validateBossName(body.remove)) {
        return resp({ ok: false, error: "老板名不合法" }, 400);
      }

      const vCheck = await checkExpectV(store, body);
      if (!vCheck.ok) {
        return resp({ ok: false, conflict: true, v: vCheck.v, error: vCheck.error || "数据已被他人修改，请刷新后重试" }, 409);
      }

      // 更新索引（过滤掉被删除的名字）
      const indexRaw = await store.get(BOSSES_INDEX);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const newIndex = index.filter(function(n) { return n !== body.remove; });
      await store.set(BOSSES_INDEX, JSON.stringify(newIndex));

      // 清理对应 Blob
      try { await store.delete(BOSS_PREFIX + body.remove); } catch (e) { console.error("delete boss blob failed:", e); }

      const newV = await bumpVersion(store);
      return resp({ ok: true, removed: body.remove, v: newV });
    }

    // ===== 模式 3：保存价格配置 =====
    if (body.taskPrices && body.keyMap) {
      if (!checkAdminPass(request)) {
        return resp({ ok: false, error: "口令错误" }, 403);
      }

      // 输入验证
      const valError = validatePricesConfig(body.taskPrices, body.keyMap);
      if (valError) {
        return resp({ ok: false, error: valError.error }, 400);
      }

      const vCheck = await checkExpectV(store, body);
      if (!vCheck.ok) {
        return resp({ ok: false, conflict: true, v: vCheck.v, error: vCheck.error || "数据已被他人修改，请刷新后重试" }, 409);
      }

      await store.set(PRICES_KEY, JSON.stringify({
        taskPrices: body.taskPrices,
        keyMap: body.keyMap,
        keyMapOrder: body.keyMapOrder || [],
        taskPriceOrder: body.taskPriceOrder || []
      }));

      const newV = await bumpVersion(store);
      return resp({ ok: true, saved: "prices", v: newV });
    }

    // 无匹配模式
    return resp({ ok: false, error: "缺少有效字段" }, 400);
  } catch (e) {
    console.error("handlePost error:", e);
    return resp({ ok: false, error: "请求处理失败" }, 400);
  }
}

// ---------- 版本号工具 ----------

/**
 * 递增版本号并返回新版本
 * 优化：读 + 写一次完成，调用方无需再读一次拿新版本
 * 注意：Netlify Blobs 无原子 CAS，存在极小概率竞态，
 *       小团队（<10 人）场景可忽略
 */
async function bumpVersion(store) {
  const curVer = await getVersion(store);
  const newVer = curVer + 1;
  await store.set(VERSION_KEY, String(newVer));
  return newVer;
}

// 读取当前版本号，失败返回 0
async function getVersion(store) {
  try {
    const r = await store.get(VERSION_KEY);
    return parseInt(r, 10) || 0;
  } catch {
    return 0;
  }
}
