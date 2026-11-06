/*
 * 声鉴娱乐标注台 · 纯逻辑核心
 *
 * 这个文件不接触 DOM、File、localStorage 或网络，只负责：
 * - 词表快照
 * - 音频元数据 / 标注记录的校验与规范化
 * - 导入合并、确认门槛
 * - 数据集 JSON / CSV / 会话备份的生成与恢复
 *
 * 浏览器里挂到 window.AnnotationCore；Node 里可 require 用于测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.AnnotationCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const APP_NAME = 'voice-label-tool';
  const APP_VERSION = '0.2.0';
  const DATASET_SCHEMA = 'label-observations-v2';
  const SESSION_SCHEMA = 'voice-label-session-v2';
  const BACKUP_SCHEMA = 'voice-label-session-backup-v2';
  const TOOL_VOCAB_VERSION = 'voice-label-vocab-0.3';
  const EXTRA_VARIANTS = Object.freeze(['极品少女御姐', '极御姐']);

  // 与 taxonomy-research/schema.json 保持一致（legacy 父类）；测试会比对，避免词表漂移。
  const TAXONOMY = Object.freeze({
    version: 'circle-taxonomy-0.4-draft',
    // 旧父类（仅兼容，不再新增）。
    parents: Object.freeze([
      '正太', '少年', '青年', '青叔', '大叔',
      '萝莉', '少萝', '少女', '少御', '御姐'
    ]),
    variants: Object.freeze([
      '温御', '青御', '大御', '烟嗓御姐', '骚御', '霸御', '妖御', '女王音',
      '冷御', '软御', '清御', '温青', '青受', '破碎青年', '极品破碎青年音', '辣条音', '超级辣条音', '超级极品辣条音', '奶太', '少正',
      '公子音', '叔攻', '御妈', '妈音'
    ]),
    texture_tags: Object.freeze(['清亮', '厚重', '气声', '颗粒感', '沙哑', '鼻音']),
    style_tags: Object.freeze(['温柔', '清冷', '活泼', '沉稳', '慵懒', '强势']),
    // 新：男女分开的主音/副音词表。voice_domain 由用户手动选择，不自动推断。
    domains: Object.freeze({
      male: Object.freeze({
        label: '男声向音色',
        primaries: Object.freeze(['正太', '少年', '青年', '青叔', '大叔', '公子', '糙汉']),
        variants: Object.freeze(['温青', '青受', '破碎青年', '极品破碎青年音', '奶太', '少正', '叔攻'])
      }),
      female: Object.freeze({
        label: '女声向音色',
        primaries: Object.freeze(['萝莉', '少萝', '少女', '少御', '御姐', '女王', '妈']),
        variants: Object.freeze(['温御', '青御', '大御', '烟嗓御姐', '骚御', '霸御', '妖御', '冷御', '软御', '清御', '御妈', '极品少女御姐', '极御姐'])
      }),
      // 两边共用的复合音，只存一份，不计入任何一边的主音。
      shared: Object.freeze(['辣条音', '超级辣条音', '超级极品辣条音'])
    })
  });

  const VOICE_DOMAINS = Object.freeze(['male', 'female']);

  function domainPrimaries(domain) {
    const entry = TAXONOMY.domains[domain];
    return entry ? entry.primaries : [];
  }

  function domainVariants(domain) {
    const entry = TAXONOMY.domains[domain];
    return entry ? entry.variants : [];
  }

  function allNewPrimaries() {
    return [...TAXONOMY.domains.male.primaries, ...TAXONOMY.domains.female.primaries];
  }

  // 仅用于界面文字；会话、编号、导出始终使用原始词表值。
  function displayPrimaryName(name) {
    const known = [...allNewPrimaries(), ...domainVariants('male'), ...domainVariants('female'), ...TAXONOMY.domains.shared];
    return known.includes(name) ? name + (name.endsWith('音') ? '' : '音') : (name || '');
  }

  // 同一个展示词可能出现在不同语境（女王音既是旧副音，也是新主音）。
  // 只在明确的方向及标签组内解析；不凭展示名推断方向或修改旧记录。
  function resolveContextualAlias(value, domain, group) {
    const name = cleanString(value, 80);
    const options = group === 'primaries' ? domainPrimaries(domain)
      : group === 'variants' ? [...domainVariants(domain), ...TAXONOMY.domains.shared]
      : [];
    if (options.includes(name)) return name;
    const matches = options.filter((canonical) => displayPrimaryName(canonical) === name);
    return matches.length === 1 ? matches[0] : '';
  }

  const LABEL_GROUPS = Object.freeze(['parents', 'variants', 'textures', 'styles', 'custom']);
  const VOICE_MODES = Object.freeze({
    unknown: '不确定',
    natural: '自然声线',
    acted: '表演/变声',
    processed: '后期处理'
  });

  // taxonomy-research/annotation-template.csv 的原始 21 列，字段顺序保持一致。
  const CSV_CANONICAL_COLUMNS = Object.freeze([
    'sample_id', 'speaker_id', 'audio_path', 'source_url', 'license_status',
    'consent_training', 'consent_record_id', 'schema_version', 'parent_label',
    'parent_candidates', 'subtype_label', 'subtype_candidates', 'texture_tags',
    'style_tags', 'voice_mode', 'text_variant', 'recording_device',
    'annotator_id', 'independence_record_id', 'label_review', 'split'
  ]);
  // 本工具额外列：自定义标签、娱乐标注状态与本地文件指纹。不伪装成训练真值。
  const CSV_EXTRA_COLUMNS = Object.freeze([
    'custom_tags', 'unsure', 'label_confirmed', 'fingerprint', 'file_name',
    'relative_path', 'duration_seconds', 'size_bytes', 'note', 'heard_audio',
    'confirmed_at', 'updated_at', 'primary_voice', 'primary_code', 'primary_seq',
    'voice_domain', 'voice_domain_label', 'primary_is_legacy', 'legacy_primary',
    'label_source', 'auto_inference_used', 'label_version'
  ]);
  const CSV_COLUMNS = Object.freeze([...CSV_CANONICAL_COLUMNS, ...CSV_EXTRA_COLUMNS]);

  function nowIso() {
    return new Date().toISOString();
  }

  function cleanString(value, maxLength) {
    if (typeof value !== 'string') return '';
    const limit = typeof maxLength === 'number' && maxLength > 0 ? maxLength : 1000;
    return value.replace(/\u0000/g, '').trim().slice(0, limit);
  }

  function toNonNegativeInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n);
  }

  function toPositiveNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 1000) / 1000;
  }

  function toTimestampOr(value, fallback) {
    return cleanString(value, 40) || fallback;
  }

  function emptyLabels() {
    return { parents: [], variants: [], textures: [], styles: [], custom: [] };
  }

  function uniqueStrings(values, maxLength, cap) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(values)) return out;
    for (const raw of values) {
      if (typeof raw !== 'string') continue;
      const value = cleanString(raw, maxLength);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
      if (out.length >= cap) break;
    }
    return out;
  }

  function isValidFingerprint(value) {
    if (typeof value !== 'string' || value.length > 1500) return false;
    if (/^sha256:[0-9a-f]{64}$/i.test(value)) return true;
    return /^fallback:.+/.test(value);
  }

  /**
   * 当浏览器没有 WebCrypto 或读取失败时的稳定兜底指纹。
   * 注意：这不是内容哈希，只在同文件名/大小/修改时间下稳定。
   */
  function fallbackFingerprint(name, size, lastModified) {
    const safeSize = Number.isFinite(Number(size)) ? Number(size) : 0;
    const safeModified = Number.isFinite(Number(lastModified)) ? Number(lastModified) : 0;
    return 'fallback:' + encodeURIComponent(String(name || '')) + '|' + safeSize + '|' + safeModified;
  }

  function sampleIdFor(fingerprint) {
    const match = /^sha256:([0-9a-f]{64})$/i.exec(String(fingerprint || ''));
    if (match) return 'clip-' + match[1].slice(0, 16).toLowerCase();
    return 'clip-local-' + fnv1a(String(fingerprint || '')).toString(16).padStart(8, '0');
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  function createClip(meta, now) {
    if (!meta || !isValidFingerprint(meta.fingerprint)) {
      throw new Error('invalid fingerprint');
    }
    const timestamp = now || nowIso();
    return {
      fingerprint: meta.fingerprint,
      file_name: cleanString(meta.file_name, 500),
      relative_path: cleanString(meta.relative_path, 1000),
      size_bytes: toNonNegativeInt(meta.size_bytes),
      last_modified: toNonNegativeInt(meta.last_modified),
      duration_seconds: toPositiveNumber(meta.duration_seconds),
      recording_id: cleanString(meta.recording_id, 100),
      source: meta.source === 'microphone' ? 'microphone' : 'local_import',
      consent_at: toTimestampOr(meta.consent_at, ''),
      consent_version: cleanString(meta.consent_version, 40),
      labels: emptyLabels(),
      // 新：男女分开主音。voice_domain 永远由用户手动点击选择，不自动推断。
      voice_domain: '',
      voice_domain_source: 'legacy_unassigned',
      primary: '',
      primary_seq: null,
      primary_seq_of: '',
      primary_is_legacy: false,
      legacy_primary: '',
      label_version: TAXONOMY.version,
      voice_mode: 'unknown',
      unsure: false,
      note: '',
      heard_audio: false,
      confirmed: false,
      created_at: timestamp,
      updated_at: timestamp,
      confirmed_at: null
    };
  }

  function mergeClipMeta(clip, meta, now) {
    if (!clip || !meta || clip.fingerprint !== meta.fingerprint) {
      throw new Error('fingerprint mismatch');
    }
    clip.file_name = cleanString(meta.file_name, 500) || clip.file_name;
    clip.relative_path = cleanString(meta.relative_path, 1000) || clip.relative_path;
    if (Number.isFinite(Number(meta.size_bytes)) && Number(meta.size_bytes) >= 0) {
      clip.size_bytes = toNonNegativeInt(meta.size_bytes);
    }
    if (Number.isFinite(Number(meta.last_modified)) && Number(meta.last_modified) >= 0) {
      clip.last_modified = toNonNegativeInt(meta.last_modified);
    }
    const duration = toPositiveNumber(meta.duration_seconds);
    if (duration !== null) clip.duration_seconds = duration;
    clip.updated_at = now || nowIso();
    return clip;
  }

  /**
   * 按指纹把新扫描的元数据并入已有队列。
   * 重复文件（同一批次或已存在）不会覆盖已有的标签/备注/确认状态。
   */
  function mergeImport(clips, metas, now) {
    const list = Array.isArray(clips) ? clips : [];
    const index = new Map(list.map((clip) => [clip.fingerprint, clip]));
    const added = [];
    const reattached = [];
    const skipped = [];
    const seen = new Set();
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (!meta || !isValidFingerprint(meta.fingerprint) || seen.has(meta.fingerprint)) {
        if (meta) skipped.push(meta);
        continue;
      }
      seen.add(meta.fingerprint);
      const existing = index.get(meta.fingerprint);
      if (existing) {
        mergeClipMeta(existing, meta, now);
        reattached.push(existing);
      } else {
        const clip = createClip(meta, now);
        list.push(clip);
        index.set(clip.fingerprint, clip);
        added.push(clip);
      }
    }
    return { clips: list, added, reattached, skipped };
  }

  function makeSession(name, annotator, now) {
    const timestamp = now || nowIso();
    return {
      schema: SESSION_SCHEMA,
      name: cleanString(name, 200) || '默认会话',
      annotator: cleanString(annotator, 200),
      taxonomy_version: TAXONOMY.version,
      created_at: timestamp,
      updated_at: timestamp,
      primary_counters: {},
      clips: []
    };
  }

  function sanitizeClip(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    if (!isValidFingerprint(raw.fingerprint)) return null;
    const timestamp = now || nowIso();

    const labels = emptyLabels();
    if (raw.labels && typeof raw.labels === 'object') {
      for (const group of LABEL_GROUPS) {
        const cap = group === 'custom' ? 30 : 100;
        const maxLength = group === 'custom' ? 40 : 80;
        labels[group] = uniqueStrings(raw.labels[group], maxLength, cap);
      }
    }

    const voiceMode = Object.prototype.hasOwnProperty.call(VOICE_MODES, raw.voice_mode)
      ? raw.voice_mode
      : 'unknown';
    const updatedAt = toTimestampOr(raw.updated_at, timestamp);
    const confirmed = raw.confirmed === true;

    const voiceDomain = VOICE_DOMAINS.includes(raw.voice_domain) ? raw.voice_domain : '';
    const newPrimaries = allNewPrimaries();
    // 新主音：必须属于合法新词表，且与 voice_domain 一致；否则视为未设置。
    let primary = '';
    let primarySeqOf = '';
    let primaryIsLegacy = false;
    let legacyPrimary = cleanString(raw.legacy_primary, 80);
    if (voiceDomain && newPrimaries.includes(raw.primary) && domainPrimaries(voiceDomain).includes(raw.primary)) {
      primary = raw.primary;
      primarySeqOf = newPrimaries.includes(raw.primary_seq_of) ? raw.primary_seq_of : primary;
    } else if (TAXONOMY.parents.includes(raw.primary)) {
      // 旧父类主音：保留为 legacy，不丢弃，不自动迁移到新词表。
      primary = raw.primary;
      primarySeqOf = TAXONOMY.parents.includes(raw.primary_seq_of) ? raw.primary_seq_of : primary;
      primaryIsLegacy = true;
      if (!legacyPrimary) legacyPrimary = raw.primary;
    } else if (raw.primary_is_legacy === true && typeof raw.primary === 'string' && raw.primary) {
      // 未知的旧 primary：保留原值到 legacy_primary，不丢标签，primary 留空不参与编号。
      primary = '';
      primarySeqOf = '';
      primaryIsLegacy = true;
      if (!legacyPrimary) legacyPrimary = cleanString(raw.primary, 80);
    }

    return {
      fingerprint: raw.fingerprint,
      file_name: cleanString(raw.file_name, 500),
      relative_path: cleanString(raw.relative_path, 1000),
      size_bytes: toNonNegativeInt(raw.size_bytes),
      last_modified: toNonNegativeInt(raw.last_modified),
      duration_seconds: toPositiveNumber(raw.duration_seconds),
      recording_id: cleanString(raw.recording_id, 100),
      source: raw.source === 'microphone' ? 'microphone' : 'local_import',
      consent_at: toTimestampOr(raw.consent_at, ''),
      consent_version: cleanString(raw.consent_version, 40),
      labels,
      voice_domain: voiceDomain,
      voice_domain_source: raw.voice_domain_source === 'manual_selection' ? 'manual_selection' : 'legacy_unassigned',
      primary: primary,
      primary_seq: Number.isSafeInteger(raw.primary_seq) && raw.primary_seq > 0 ? raw.primary_seq : null,
      primary_seq_of: primarySeqOf,
      primary_is_legacy: primaryIsLegacy,
      legacy_primary: legacyPrimary,
      label_version: cleanString(raw.label_version, 60) || TAXONOMY.version,
      voice_mode: voiceMode,
      unsure: raw.unsure === true,
      note: cleanString(raw.note, 1000),
      heard_audio: raw.heard_audio === true,
      confirmed,
      created_at: toTimestampOr(raw.created_at, updatedAt),
      updated_at: updatedAt,
      confirmed_at: confirmed ? toTimestampOr(raw.confirmed_at, updatedAt) : null
    };
  }

  /**
   * 规范化本地存储 / 备份导入的会话；坏记录会被丢弃而不是让整个页面崩溃。
   * 返回 null 表示根本无法识别。
   */
  function sanitizeSession(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    const timestamp = now || nowIso();
    const clips = [];
    const seen = new Set();
    if (Array.isArray(raw.clips)) {
      for (const item of raw.clips) {
        const clip = sanitizeClip(item, timestamp);
        if (!clip || seen.has(clip.fingerprint)) continue;
        seen.add(clip.fingerprint);
        clips.push(clip);
      }
    }
    const counters = {};
    for (const parent of [...TAXONOMY.parents, ...allNewPrimaries()]) {
      const value = raw.primary_counters && raw.primary_counters[parent];
      counters[parent] = Number.isSafeInteger(value) && value > 0 ? value : 0;
    }
    for (const clip of clips) {
      if (clip.primary_seq_of && clip.primary_seq) counters[clip.primary_seq_of] = Math.max(counters[clip.primary_seq_of], clip.primary_seq);
    }
    const allocated = new Set();
    for (const clip of [...clips].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      if (!clip.primary_seq_of || !clip.primary_seq) {
        clip.primary_seq = null;
        clip.primary_seq_of = '';
        if (clip.primary) {
          clip.primary_seq_of = clip.primary;
          clip.primary_seq = ++counters[clip.primary];
          allocated.add(clip.primary + ':' + clip.primary_seq);
        }
        continue;
      }
      const key = clip.primary_seq_of + ':' + clip.primary_seq;
      if (allocated.has(key)) {
        // Keep the earliest allocation; repair duplicate codes without dropping a label.
        counters[clip.primary_seq_of] = Math.max(counters[clip.primary_seq_of], clip.primary_seq);
        clip.primary_seq = ++counters[clip.primary_seq_of];
      }
      allocated.add(clip.primary_seq_of + ':' + clip.primary_seq);
      counters[clip.primary_seq_of] = Math.max(counters[clip.primary_seq_of], clip.primary_seq);
    }
    return {
      schema: SESSION_SCHEMA,
      name: cleanString(raw.name, 200) || '默认会话',
      annotator: cleanString(raw.annotator, 200),
      taxonomy_version: cleanString(raw.taxonomy_version, 100) || TAXONOMY.version,
      created_at: toTimestampOr(raw.created_at, timestamp),
      updated_at: toTimestampOr(raw.updated_at, timestamp),
      primary_counters: counters,
      clips
    };
  }

  function hasLabels(clip) {
    if (!clip || !clip.labels) return false;
    return LABEL_GROUPS.some((group) => Array.isArray(clip.labels[group]) && clip.labels[group].length > 0);
  }

  function hasAnyAnnotation(clip) {
    if (!clip) return false;
    return Boolean(clip.primary) || hasLabels(clip) || clip.unsure === true || Boolean(clip.note && clip.note.trim()) ||
      (clip.voice_mode && clip.voice_mode !== 'unknown');
  }

  function statusOf(clip) {
    if (!clip) return 'unlabeled';
    if (clip.confirmed) return 'confirmed';
    return hasAnyAnnotation(clip) ? 'draft' : 'unlabeled';
  }

  function countStatuses(clips) {
    const counts = { total: 0, confirmed: 0, draft: 0, unlabeled: 0 };
    for (const clip of Array.isArray(clips) ? clips : []) {
      counts.total += 1;
      counts[statusOf(clip)] += 1;
    }
    return counts;
  }

  /**
   * 确认门槛：标注代号 + 曾经完整播放到结尾 + 至少一个主音/无法确定。
   * 简化版确认门槛：有效主音（新词表或旧 legacy）或勾选"无法确定"即可，
   * 不要求必须选标注代号才能保存标签本身（标注代号仍用于确认归档）。
   */
  function canConfirm(clip, annotator) {
    if (!clip) return { ok: false, reason: '没有选中的音频。' };
    if (clip.confirmed) return { ok: false, reason: '该条已经确认；如需修改请先重新编辑。' };
    if (!cleanString(annotator, 200)) return { ok: false, reason: '请先填写标注代号。' };
    if (clip.heard_audio !== true) return { ok: false, reason: '请先完整播放到结尾。' };
    const hasValidPrimary = Boolean(clip.primary) && clip.primary_seq_of === clip.primary && Boolean(clip.primary_seq);
    if (!hasValidPrimary && clip.unsure !== true) {
      return { ok: false, reason: '请选择一个主音（会立即编号），或勾选"无法确定"。' };
    }
    return { ok: true, reason: '' };
  }

  function primaryCode(clip) {
    return clip && clip.primary && clip.primary_seq_of === clip.primary && clip.primary_seq
      ? clip.primary + '音-' + String(clip.primary_seq).padStart(3, '0') : '';
  }

  /**
   * 设置主音。新主音必须先设置 clip.voice_domain（手动选择），且 name 必须属于该
   * domain 的词表；旧父类主音仍可通过传入 { legacy: true } 设置，用于兼容迁移向导。
   */
  function setPrimary(session, clip, name, now) {
    if (!session || !clip || clip.confirmed) return false;
    if (name) {
      if (!clip.voice_domain) return false; // 必须先选方向，不自动推断
      if (!domainPrimaries(clip.voice_domain).includes(name)) return false;
    }
    const chosen = clip.primary === name ? '' : name;
    if (chosen && (clip.primary_seq_of !== chosen || !clip.primary_seq)) {
      if (!session.primary_counters) session.primary_counters = {};
      const previous = Number(session.primary_counters[chosen]) || 0;
      const existing = Array.isArray(session.clips) ? session.clips.reduce((max, item) =>
        item.primary_seq_of === chosen ? Math.max(max, Number(item.primary_seq) || 0) : max, 0) : 0;
      clip.primary_seq = Math.max(previous, existing) + 1;
      session.primary_counters[chosen] = clip.primary_seq;
      clip.primary_seq_of = chosen;
    }
    clip.primary = chosen;
    if (chosen) clip.primary_is_legacy = false;
    // 不清空 primary_seq_of/primary_seq：原编号保留不复用，再次选回同一主音会重用旧编号。
    touchClip(clip, now);
    return true;
  }

  /**
   * 设置方向（男声/女声）。切换方向会清空当前新主音选择（旧 legacy 主音不受影响），
   * 避免跨方向残留错位标签；调用方应在切换前做二次确认。
   */
  function setVoiceDomain(clip, domain, now) {
    if (!clip || clip.confirmed) return false;
    if (domain && !VOICE_DOMAINS.includes(domain)) return false;
    const next = domain || '';
    if (clip.voice_domain === next) return true;
    clip.voice_domain = next;
    clip.voice_domain_source = next ? 'manual_selection' : 'legacy_unassigned';
    // 方向改变时，若当前主音不属于新方向，清空（不自动迁移/不自动猜）。
    if (clip.primary && !clip.primary_is_legacy && (!next || !domainPrimaries(next).includes(clip.primary))) {
      clip.primary = '';
      clip.primary_seq_of = '';
    }
    touchClip(clip, now);
    return true;
  }

  function setUnsure(clip, value, now) {
    if (!clip || clip.confirmed) return false;
    clip.unsure = value === true;
    if (clip.unsure) {
      // 无法确定与主音互斥：清空新主音；legacy 主音保留供查看。
      if (clip.primary && !clip.primary_is_legacy) {
        clip.primary = '';
        clip.primary_seq_of = '';
      }
    }
    touchClip(clip, now);
    return true;
  }

  function confirmClip(session, clip, annotator, now) {
    const result = canConfirm(clip, annotator);
    if (!result.ok) return result;
    session.annotator = cleanString(annotator, 200);
    clip.confirmed = true;
    clip.confirmed_at = now || nowIso();
    touchClip(clip, clip.confirmed_at);
    return { ok: true, reason: '' };
  }

  /**
   * 删除一个 clip（从 session.clips 数组移除）。只操作内存结构；
   * 调用方负责同时删除 IndexedDB 录音 blob（先写标签变更成功后再删 blob）。
   * 返回被移除的 clip（含 recording_id，供调用方清理），不存在返回 null。
   */
  function removeClip(session, fingerprint) {
    if (!session || !Array.isArray(session.clips)) return null;
    const index = session.clips.findIndex((c) => c.fingerprint === fingerprint);
    if (index < 0) return null;
    const [removed] = session.clips.splice(index, 1);
    session.updated_at = nowIso();
    return removed;
  }

  /**
   * 按声音方向（domain）与主音分组，用于男/女两个独立页面的队列展示。
   * domain 为 'male' | 'female'；只返回属于该方向的主音分组 + 未归类。
   * 不属于该方向的 clip（包括另一方向、旧档、未选方向）不出现在结果里，
   * 调用方应单独展示"其它/旧档"列表。
   */
  function groupByPrimary(clips, domain) {
    const names = domain ? domainPrimaries(domain) : [...new Set([...allNewPrimaries(), ...TAXONOMY.parents])];
    const groups = [...names, '未归类'].map((name) => ({ name, clips: [] }));
    for (const clip of Array.isArray(clips) ? clips : []) {
      // 排除已明确归入"另一方向"的条目；未选方向（voice_domain === ''）的新录音/导入音频
      // 仍应在两页都可见，落入"未归类"分组，供用户在本页手动认领（点选主音即认领），不自动分配。
      if (domain && clip.voice_domain && clip.voice_domain !== domain) continue;
      const index = names.indexOf(clip.primary);
      groups[index < 0 ? groups.length - 1 : index].clips.push(clip);
    }
    for (const group of groups) group.clips.sort((a, b) =>
      (a.primary_seq || Infinity) - (b.primary_seq || Infinity) || a.created_at.localeCompare(b.created_at));
    return groups;
  }

  function touchClip(clip, now) {
    clip.updated_at = now || nowIso();
  }

  function toggleLabel(clip, group, value, now) {
    if (!clip || !clip.labels || !LABEL_GROUPS.includes(group)) return false;
    const cleaned = cleanString(value, group === 'custom' ? 40 : 80);
    if (!cleaned) return false;
    const list = clip.labels[group];
    const existingIndex = list.indexOf(cleaned);
    if (existingIndex >= 0) {
      list.splice(existingIndex, 1);
    } else {
      list.push(cleaned);
    }
    touchClip(clip, now);
    return true;
  }

  function addCustomTag(clip, rawValue, now) {
    if (!clip || !clip.labels) return { added: false, reason: '没有选中的音频。' };
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!value) return { added: false, reason: '标签不能为空。' };
    if (value.length > 40) return { added: false, reason: '标签过长（最多 40 字）。' };
    if (clip.labels.custom.includes(value)) return { added: false, value, reason: '这个标签已经存在。' };
    if (clip.labels.custom.length >= 30) return { added: false, reason: '每条音频最多 30 个自定义标签。' };
    clip.labels.custom.push(value);
    touchClip(clip, now);
    return { added: true, value, reason: '' };
  }

  function removeCustomTag(clip, value, now) {
    if (!clip || !clip.labels || !Array.isArray(clip.labels.custom)) return false;
    const index = clip.labels.custom.indexOf(value);
    if (index < 0) return false;
    clip.labels.custom.splice(index, 1);
    touchClip(clip, now);
    return true;
  }

  function observationFromClip(clip, session) {
    const mode = Object.prototype.hasOwnProperty.call(VOICE_MODES, clip.voice_mode)
      ? clip.voice_mode
      : 'unknown';
    return {
      sample_id: sampleIdFor(clip.fingerprint),
      fingerprint: clip.fingerprint,
      file_name: clip.file_name,
      relative_path: clip.relative_path,
      duration_seconds: clip.duration_seconds,
      size_bytes: clip.size_bytes,
      last_modified: clip.last_modified,
      voice_domain: clip.voice_domain || '',
      voice_domain_label: clip.voice_domain ? TAXONOMY.domains[clip.voice_domain].label : '',
      voice_domain_source: clip.voice_domain_source || 'legacy_unassigned',
      primary_voice: clip.primary || '',
      primary_voice_label: clip.primary ? displayPrimaryName(clip.primary) : '',
      primary_seq: clip.primary_seq_of === clip.primary && clip.primary ? clip.primary_seq : null,
      primary_code: primaryCode(clip),
      primary_is_legacy: clip.primary_is_legacy === true,
      legacy_primary: clip.legacy_primary || null,
      parent_candidates: [...clip.labels.parents],
      subtype_candidates: [...clip.labels.variants],
      texture_tags: [...clip.labels.textures],
      style_tags: [...clip.labels.styles],
      custom_tags: [...clip.labels.custom],
      voice_mode: mode,
      voice_mode_label: VOICE_MODES[mode],
      unsure: clip.unsure === true,
      note: clip.note,
      heard_audio: clip.heard_audio === true,
      confirmed: clip.confirmed === true,
      status: statusOf(clip),
      created_at: clip.created_at,
      updated_at: clip.updated_at,
      confirmed_at: clip.confirmed_at,
      source: clip.source === 'microphone' ? 'microphone' : 'local_import',
      recording_id: clip.recording_id || '',
      consent_at: clip.consent_at || '',
      consent_version: clip.consent_version || '',
      label_review: 'unreviewed',
      training_enabled: false,
      blind_attested: false,
      label_source: 'manual',
      auto_inference_used: false,
      legacy_taxonomy_version: clip.primary_is_legacy ? TAXONOMY.version : null,
      annotator_id: session && session.annotator ? session.annotator : ''
    };
  }

  function buildDataset(session, now) {
    const safeSession = sanitizeSession(session) || makeSession('默认会话', '');
    const counts = countStatuses(safeSession.clips);
    return {
      schema: DATASET_SCHEMA,
      tool: { name: APP_NAME, version: APP_VERSION },
      taxonomy_version: safeSession.taxonomy_version,
      tool_vocab_version: TOOL_VOCAB_VERSION,
      taxonomy: {
        version: TAXONOMY.version,
        parents: [...TAXONOMY.parents],
        variants: [...TAXONOMY.variants, ...EXTRA_VARIANTS],
        texture_tags: [...TAXONOMY.texture_tags],
        style_tags: [...TAXONOMY.style_tags],
        domains: {
          male: { label: TAXONOMY.domains.male.label, primaries: [...TAXONOMY.domains.male.primaries], variants: [...TAXONOMY.domains.male.variants] },
          female: { label: TAXONOMY.domains.female.label, primaries: [...TAXONOMY.domains.female.primaries], variants: [...TAXONOMY.domains.female.variants] },
          shared: [...TAXONOMY.domains.shared]
        },
        legacy: { parents: [...TAXONOMY.parents], variants: [...TAXONOMY.variants, ...EXTRA_VARIANTS] }
      },
      exported_at: now || nowIso(),
      audio_policy: 'local_only_no_upload',
      session: {
        name: safeSession.name,
        annotator: safeSession.annotator,
        created_at: safeSession.created_at,
        updated_at: safeSession.updated_at
      },
      counts,
      observations: safeSession.clips.map((clip) => observationFromClip(clip, safeSession))
    };
  }

  // A shared journal protocol: damaged or unfamiliar entries must remain in place.
  function recoveryJournalKey(name) {
    return 'voice-label-recovery-intent:' + encodeURIComponent(name || '默认会话');
  }

  function parseRecoveryJournal(raw, name) {
    if (!raw) return { ok: false, reason: '没有待恢复操作。' };
    let entry;
    try { entry = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (error) { return { ok: false, reason: '恢复日志 JSON 损坏。' }; }
    if (!entry || entry.session !== name) return { ok: false, reason: '恢复日志会话不匹配。' };
    if (entry.type === 'delete') {
      if (!entry.clip || typeof entry.clip.fingerprint !== 'string' || !Number.isInteger(entry.index) || entry.index < 0 || typeof entry.recordingId !== 'string') return { ok: false, reason: '删除日志结构无效。' };
    } else if (entry.type === 'import') {
      if (!Array.isArray(entry.ids) || entry.ids.some((id) => typeof id !== 'string' || !id)) return { ok: false, reason: '导入日志结构无效。' };
    } else if (entry.type === 'recording-save') {
      if (typeof entry.before !== 'string' || typeof entry.after !== 'string' || entry.before === entry.after ||
          typeof entry.recordingId !== 'string' || !entry.recordingId || typeof entry.fingerprint !== 'string' || !entry.fingerprint ||
          !Number.isSafeInteger(entry.size) || entry.size <= 0 || typeof entry.mimeType !== 'string' || !entry.mimeType) return { ok: false, reason: '录音保存日志结构无效。' };
      try {
        const before = sanitizeSession(JSON.parse(entry.before));
        const after = sanitizeSession(JSON.parse(entry.after));
        if (!before || !after || before.name !== name || after.name !== name ||
            before.clips.some((clip) => clip.recording_id === entry.recordingId || clip.fingerprint === entry.fingerprint) ||
            after.clips.filter((clip) => clip.recording_id === entry.recordingId && clip.fingerprint === entry.fingerprint && clip.size_bytes === entry.size).length !== 1 ||
            after.clips.length !== before.clips.length + 1 ||
            before.clips.some((clip, index) => JSON.stringify(clip) !== JSON.stringify(after.clips[index]))) return { ok: false, reason: '录音保存快照无效。' };
      } catch (error) { return { ok: false, reason: '录音保存快照无效。' }; }
    } else return { ok: false, reason: '未知恢复日志类型。' };
    return { ok: true, entry };
  }

  function recoveryDecision(entry, currentRaw, audioPresent) {
    if (!entry || (entry.type !== 'delete' && entry.type !== 'import' && entry.type !== 'recording-save')) return { action: 'block', reason: '未知操作，禁止自动恢复。' };
    if (entry.type === 'recording-save') {
      if (currentRaw !== entry.before && currentRaw !== entry.after) return { action: 'block', reason: '会话版本已变化，禁止覆盖。' };
      if (!audioPresent || audioPresent.id !== entry.recordingId || !(audioPresent.blob instanceof Blob) ||
          audioPresent.blob.size !== entry.size || audioPresent.blob.type !== entry.mimeType || audioPresent.mime_type !== entry.mimeType)
        return { action: 'block', reason: '录音 ID、大小或类型不匹配。' };
      return { action: currentRaw === entry.before ? 'commit-recording-save' : 'verify-recording-save', reason: '' };
    }
    if (entry.type === 'delete') {
      if (!audioPresent) return { action: 'block', reason: '录音缺失，保留日志并等待人工核对。' };
      if (entry.before !== undefined && entry.after !== undefined && currentRaw !== entry.before && currentRaw !== entry.after) return { action: 'block', reason: '会话版本已变化，禁止覆盖。' };
      return { action: 'restore-delete', reason: '' };
    }
    if (entry.before === undefined || entry.after === undefined) return { action: 'block', reason: '导入日志缺少版本快照，禁止自动清理。' };
    if (currentRaw !== entry.before && currentRaw !== entry.after) return { action: 'block', reason: '会话版本已变化，禁止覆盖。' };
    return { action: currentRaw === entry.after ? 'verify-import' : 'rollback-import', reason: '' };
  }

  function buildBackup(session, now) {
    const safeSession = sanitizeSession(session) || makeSession('默认会话', '');
    return {
      schema: BACKUP_SCHEMA,
      app: APP_NAME,
      app_version: APP_VERSION,
      exported_at: now || nowIso(),
      session: safeSession
    };
  }

  function parseSessionBackup(input) {
    let raw = input;
    if (typeof input === 'string') {
      try {
        raw = JSON.parse(input);
      } catch (error) {
        return { ok: false, reason: 'JSON 解析失败。' };
      }
    }
    if (!raw || typeof raw !== 'object') {
      return { ok: false, reason: '文件内容不是对象。' };
    }
    if (raw.schema === BACKUP_SCHEMA) {
      const session = sanitizeSession(raw.session);
      if (!session) return { ok: false, reason: '备份中的会话结构无效。' };
      return { ok: true, session, reason: '' };
    }
    if (raw.schema === SESSION_SCHEMA) {
      const session = sanitizeSession(raw);
      if (!session) return { ok: false, reason: '会话结构无效。' };
      return { ok: true, session, reason: '' };
    }
    return { ok: false, reason: '无法识别的文件类型；需要本工具导出的会话备份或会话 JSON。' };
  }

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function buildCsv(session) {
    const safeSession = sanitizeSession(session) || makeSession('默认会话', '');
    const rows = [CSV_COLUMNS.join(',')];
    for (const clip of safeSession.clips) {
      const audioPath = clip.relative_path || clip.file_name;
      const values = [
        sampleIdFor(clip.fingerprint),           // sample_id
        '',                                      // speaker_id（本地导入未知）
        audioPath,                               // audio_path（仅原文件名/相对路径）
        '',                                      // source_url
        'unknown',                               // license_status
        'false',                                 // consent_training
        '',                                      // consent_record_id
        safeSession.taxonomy_version,            // schema_version
        '',                                      // parent_label（不伪造单一真值）
        clip.labels.parents.join('|'),           // parent_candidates
        '',                                      // subtype_label
        clip.labels.variants.join('|'),          // subtype_candidates
        clip.labels.textures.join('|'),          // texture_tags
        clip.labels.styles.join('|'),            // style_tags
        clip.voice_mode,                         // voice_mode
        '',                                      // text_variant
        '',                                      // recording_device
        safeSession.annotator,                   // annotator_id
        '',                                      // independence_record_id
        'unreviewed',                            // label_review
        '',                                      // split
        clip.labels.custom.join('|'),            // custom_tags
        clip.unsure ? 'true' : 'false',          // unsure
        clip.confirmed ? 'true' : 'false',       // label_confirmed
        clip.fingerprint,                        // fingerprint
        clip.file_name,                          // file_name
        clip.relative_path,                      // relative_path
        clip.duration_seconds === null ? '' : clip.duration_seconds,
        clip.size_bytes,                         // size_bytes
        clip.note,                               // note
        clip.heard_audio ? 'true' : 'false',     // heard_audio
        clip.confirmed_at || '',                 // confirmed_at
        clip.updated_at,                         // updated_at
        clip.primary || '',                       // primary_voice (local candidate)
        primaryCode(clip),                        // primary_code
        primaryCode(clip) ? clip.primary_seq : '', // primary_seq
        clip.voice_domain || '',                                               // voice_domain
        clip.voice_domain ? TAXONOMY.domains[clip.voice_domain].label : '',    // voice_domain_label
        clip.primary_is_legacy ? 'true' : 'false',                            // primary_is_legacy
        clip.legacy_primary || '',                                             // legacy_primary
        'manual',                                                              // label_source
        'false',                                                               // auto_inference_used
        clip.label_version || TAXONOMY.version                                // label_version
      ];
      rows.push(values.map(csvEscape).join(','));
    }
    return rows.join('\r\n') + '\r\n';
  }

  return {
    APP_NAME,
    APP_VERSION,
    DATASET_SCHEMA,
    SESSION_SCHEMA,
    BACKUP_SCHEMA,
    TOOL_VOCAB_VERSION,
    EXTRA_VARIANTS,
    TAXONOMY,
    VOICE_DOMAINS,
    LABEL_GROUPS,
    VOICE_MODES,
    CSV_COLUMNS,
    CSV_CANONICAL_COLUMNS,
    CSV_EXTRA_COLUMNS,
    cleanString,
    fallbackFingerprint,
    isValidFingerprint,
    sampleIdFor,
    domainPrimaries,
    domainVariants,
    allNewPrimaries,
    displayPrimaryName,
    resolveContextualAlias,
    createClip,
    mergeClipMeta,
    mergeImport,
    makeSession,
    sanitizeClip,
    sanitizeSession,
    hasLabels,
    hasAnyAnnotation,
    statusOf,
    countStatuses,
    canConfirm,
    primaryCode,
    setPrimary,
    setVoiceDomain,
    setUnsure,
    confirmClip,
    removeClip,
    groupByPrimary,
    toggleLabel,
    addCustomTag,
    removeCustomTag,
    observationFromClip,
    buildDataset,
    buildBackup,
    parseSessionBackup,
    recoveryJournalKey,
    parseRecoveryJournal,
    recoveryDecision,
    csvEscape,
    buildCsv
  };
});
