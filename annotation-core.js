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
  const APP_VERSION = '0.1.0';
  const DATASET_SCHEMA = 'label-observations-v1';
  const SESSION_SCHEMA = 'voice-label-session-v1';
  const BACKUP_SCHEMA = 'voice-label-session-backup-v1';

  // 与 taxonomy-research/schema.json 保持一致；测试会比对，避免词表漂移。
  const TAXONOMY = Object.freeze({
    version: 'circle-taxonomy-0.3-draft',
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
    style_tags: Object.freeze(['温柔', '清冷', '活泼', '沉稳', '慵懒', '强势'])
  });

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
    'confirmed_at', 'updated_at'
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
    return {
      schema: SESSION_SCHEMA,
      name: cleanString(raw.name, 200) || '默认会话',
      annotator: cleanString(raw.annotator, 200),
      taxonomy_version: cleanString(raw.taxonomy_version, 100) || TAXONOMY.version,
      created_at: toTimestampOr(raw.created_at, timestamp),
      updated_at: toTimestampOr(raw.updated_at, timestamp),
      clips
    };
  }

  function hasLabels(clip) {
    if (!clip || !clip.labels) return false;
    return LABEL_GROUPS.some((group) => Array.isArray(clip.labels[group]) && clip.labels[group].length > 0);
  }

  function hasAnyAnnotation(clip) {
    if (!clip) return false;
    return hasLabels(clip) || clip.unsure === true || Boolean(clip.note && clip.note.trim()) ||
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
   * 确认门槛：标注代号 + 曾经完整播放到结尾 + 至少一个标签或“无法确定”。
   * 备注和声线状态单独不算标签，避免空选即确认。
   */
  function canConfirm(clip, annotator) {
    if (!clip) return { ok: false, reason: '没有选中的音频。' };
    if (clip.confirmed) return { ok: false, reason: '该条已经确认；如需修改请先重新编辑。' };
    if (!cleanString(annotator, 200)) return { ok: false, reason: '请先填写标注代号。' };
    if (clip.heard_audio !== true) return { ok: false, reason: '请先完整播放到结尾。' };
    if (!hasLabels(clip) && clip.unsure !== true) {
      return { ok: false, reason: '至少选择一个标签，或勾选“无法确定”。' };
    }
    return { ok: true, reason: '' };
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
      taxonomy: {
        version: TAXONOMY.version,
        parents: [...TAXONOMY.parents],
        variants: [...TAXONOMY.variants],
        texture_tags: [...TAXONOMY.texture_tags],
        style_tags: [...TAXONOMY.style_tags]
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
        clip.updated_at                          // updated_at
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
    TAXONOMY,
    LABEL_GROUPS,
    VOICE_MODES,
    CSV_COLUMNS,
    CSV_CANONICAL_COLUMNS,
    CSV_EXTRA_COLUMNS,
    cleanString,
    fallbackFingerprint,
    isValidFingerprint,
    sampleIdFor,
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
    toggleLabel,
    addCustomTag,
    removeCustomTag,
    observationFromClip,
    buildDataset,
    buildBackup,
    parseSessionBackup,
    csvEscape,
    buildCsv
  };
});
