import type { CourseModule, CourseProject, LessonStep } from './models';

/* ------------------------------------------------------------------ */
/* 常量与类型                                                           */
/* ------------------------------------------------------------------ */

export const PACKAGE_FORMAT = 'signcourse-offline-package';
export const PACKAGE_VERSION = 1;
export const MERGE_SESSION_KEY = 'sologsb-1012-merge-session-v1';
export const TABLET_STORAGE_KEY = 'sologsb-1012-tablet-project-v1';
export const TABLET_BASE_KEY = 'sologsb-1012-tablet-base-v1';
export const OFFLINE_PACKAGE_KEY = 'sologsb-1012-offline-package-v1';
export const DEVICE_MODE_KEY = 'sologsb-1012-device-mode-v1';

export const LOCAL_SIDE_LABEL = '电脑工作稿';
export const INCOMING_SIDE_LABEL = '平板离线稿';

export type MergeSide = 'local' | 'incoming';

/** 离线课程包：base 为导出时的共同快照，tablet 为平板离线修改后的工作稿 */
export interface OfflinePackage {
  format: typeof PACKAGE_FORMAT;
  packageVersion: number;
  exportedAt: string;
  projectId: string;
  teacher: string;
  baseRevision: number;
  base: CourseProject;
  tablet: CourseProject;
}

export interface MergeChange {
  id: string;
  level: 'project' | 'module' | 'step';
  moduleId?: string;
  stepId?: string;
  source: MergeSide | 'both' | 'system';
  message: string;
}

export interface OrderEntry {
  id: string;
  title: string;
}

interface ConflictBase {
  id: string;
  resolved: boolean;
}

/** 同一位置两边都改过且内容不同：先保留两份，逐字段选择后才生效 */
export interface FieldConflict extends ConflictBase {
  kind: 'field';
  level: 'project' | 'module' | 'step';
  moduleId?: string;
  stepId?: string;
  location: string;
  field: string;
  fieldLabel: string;
  baseValue: unknown;
  localValue: unknown;
  incomingValue: unknown;
  resolution?: MergeSide;
}

/** 一边删除、另一边修改：选择保留改动还是执行删除 */
export interface DeleteModifyConflict extends ConflictBase {
  kind: 'delete-modify';
  level: 'module' | 'step';
  moduleId: string;
  stepId?: string;
  location: string;
  deletingSide: MergeSide;
  keepingSide: MergeSide;
  resolution?: 'keep' | 'drop';
}

/** 两边都调整了同一层级的顺序且结果不同 */
export interface OrderConflict extends ConflictBase {
  kind: 'order';
  level: 'module' | 'step';
  moduleId?: string;
  location: string;
  baseOrder: OrderEntry[];
  localOrder: OrderEntry[];
  incomingOrder: OrderEntry[];
  resolution?: MergeSide;
}

export type MergeConflict = FieldConflict | DeleteModifyConflict | OrderConflict;

export interface MergeSession {
  id: string;
  startedAt: string;
  packageExportedAt: string;
  baseRevision: number;
  base: CourseProject;
  local: CourseProject;
  incoming: CourseProject;
  moduleQueue: string[];
  processedModuleIds: string[];
  projectConflicts: MergeConflict[];
  conflicts: MergeConflict[];
  changes: MergeChange[];
  analysisComplete: boolean;
  failAfterProcessed?: number;
  lastError?: string;
}

export class MergeInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeInterruptedError';
  }
}

/* ------------------------------------------------------------------ */
/* 字段元数据（供引擎与界面共用）                                        */
/* ------------------------------------------------------------------ */

interface FieldDef<T> {
  key: keyof T & string;
  label: string;
}

export const STEP_FIELDS: FieldDef<LessonStep>[] = [
  { key: 'title', label: '步骤标题' },
  { key: 'kind', label: '步骤类型' },
  { key: 'duration', label: '预计时长' },
  { key: 'demoTitle', label: '示范片段名称' },
  { key: 'demoUrl', label: '本地素材地址' },
  { key: 'handshape', label: '手形说明' },
  { key: 'gestureZone', label: '主要动作区域' },
  { key: 'caption', label: '字幕' },
  { key: 'captionPosition', label: '字幕位置' },
  { key: 'camera', label: '镜头角度' },
  { key: 'commonMistakes', label: '常见错误' },
  { key: 'exercise', label: '练习任务' },
  { key: 'exerciseFeedback', label: '练习反馈' },
  { key: 'altText', label: '替代文本' },
  { key: 'prerequisiteId', label: '前置条件' },
  { key: 'difficulty', label: '难度标签' },
  { key: 'cuePoints', label: '检查点' },
];

export const MODULE_FIELDS: FieldDef<CourseModule>[] = [
  { key: 'title', label: '模块标题' },
  { key: 'summary', label: '模块目标' },
  { key: 'color', label: '主题色' },
];

export const PROJECT_FIELDS: FieldDef<CourseProject>[] = [
  { key: 'title', label: '课程标题' },
  { key: 'teacher', label: '授课教师' },
  { key: 'audience', label: '适用对象' },
];

export function stepFieldLabel(field: string): string {
  return STEP_FIELDS.find((item) => item.key === field)?.label ?? field;
}

/** 把字段值转成可在差异卡片中阅读的文本（prerequisiteId 需要标题映射） */
export function formatFieldValue(field: string, value: unknown, prerequisiteTitle?: (id: string) => string | undefined): string {
  if (field === 'prerequisiteId') {
    const id = String(value ?? '');
    if (!id) return '无前置条件';
    return prerequisiteTitle?.(id) ?? id;
  }
  if (field === 'commonMistakes') {
    const list = Array.isArray(value) ? value.map(String) : [];
    return list.length ? list.join('；') : '（未记录）';
  }
  if (field === 'cuePoints') {
    const list = Array.isArray(value) ? value.map(String) : [];
    return list.length ? `${list.join('、')} 秒` : '（无检查点）';
  }
  if (field === 'color') return String(value ?? '');
  if (field === 'duration') return value === '' || value === undefined ? '（未设置）' : `${value} 秒`;
  if (value === '' || value === undefined || value === null) return '（空）';
  if (Array.isArray(value)) return value.map(String).join('、');
  return String(value);
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

export function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function sideLabel(side: MergeSide | 'both' | 'system'): string {
  if (side === 'local') return LOCAL_SIDE_LABEL;
  if (side === 'incoming') return INCOMING_SIDE_LABEL;
  if (side === 'both') return '两边';
  return '系统';
}

function moduleMap(project: CourseProject): Map<string, CourseModule> {
  return new Map(project.modules.map((module) => [module.id, module]));
}

function stepMap(module: CourseModule | undefined): Map<string, LessonStep> {
  return new Map((module?.steps ?? []).map((step) => [step.id, step]));
}

/* ------------------------------------------------------------------ */
/* 有序列表三向合并（模块、步骤共用）                                     */
/* ------------------------------------------------------------------ */

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 按相邻锚点把一侧新增/保留的条目插入合并顺序 */
function insertExtras(core: string[], sideList: string[], extras: string[]): string[] {
  const result = [...core];
  const placed = new Set(result);
  for (const id of extras) {
    if (placed.has(id)) continue;
    let insertAt = result.length;
    const sideIndex = sideList.indexOf(id);
    for (let i = sideIndex - 1; i >= 0; i -= 1) {
      const anchorIndex = result.indexOf(sideList[i]);
      if (anchorIndex >= 0) {
        insertAt = anchorIndex + 1;
        break;
      }
    }
    result.splice(insertAt, 0, id);
    placed.add(id);
  }
  return result;
}

/**
 * 有序条目三向合并：
 * - 只有一边改顺序 -> 直接采用该边顺序
 * - 两边都改且结果不同 -> conflict=true，暂定 local 顺序，等教师选择
 * - 单边新增按各自锚点插入；单边删除的条目在状态判定后另行过滤
 */
function mergeOrderedIds(
  baseIds: string[],
  localIds: string[],
  incomingIds: string[],
  prefer?: MergeSide,
): { order: string[]; conflict: boolean } {
  const localSet = new Set(localIds);
  const incomingSet = new Set(incomingIds);
  const bothDeleted = new Set(baseIds.filter((id) => !localSet.has(id) && !incomingSet.has(id)));
  const survivors = baseIds.filter((id) => localSet.has(id) && incomingSet.has(id));
  const baseCore = baseIds.filter((id) => survivors.includes(id));
  const localCore = localIds.filter((id) => survivors.includes(id));
  const incomingCore = incomingIds.filter((id) => survivors.includes(id));
  const localMoved = !sameOrder(localCore, baseCore);
  const incomingMoved = !sameOrder(incomingCore, baseCore);
  const conflict = localMoved && incomingMoved && !sameOrder(localCore, incomingCore);

  let core = baseCore;
  if (conflict) core = prefer === 'incoming' ? incomingCore : localCore;
  else if (localMoved) core = localCore;
  else if (incomingMoved) core = incomingCore;

  const coreSet = new Set(core);
  const localExtras = localIds.filter((id) => !coreSet.has(id) && !bothDeleted.has(id));
  const localExtraSet = new Set(localExtras);
  const incomingExtras = incomingIds.filter((id) => !coreSet.has(id) && !bothDeleted.has(id) && !localExtraSet.has(id));

  let order = insertExtras(core, localIds, localExtras);
  order = insertExtras(order, incomingIds, incomingExtras);
  return { order, conflict };
}

/* ------------------------------------------------------------------ */
/* 条目存在状态判定                                                     */
/* ------------------------------------------------------------------ */

type ItemStatus =
  | 'common'
  | 'added-local'
  | 'added-incoming'
  | 'added-both'
  | 'deleted-both'
  | 'deleted-auto'          // 一边删除、另一边未动 -> 直接接受删除
  | 'delete-conflict';      // 一边删除、另一边改过 -> 待选择

interface Presence {
  inBase: boolean;
  inLocal: boolean;
  inIncoming: boolean;
}

function classifyItem(presence: Presence, localChanged: boolean, incomingChanged: boolean): ItemStatus {
  const { inBase, inLocal, inIncoming } = presence;
  if (!inBase) {
    if (inLocal && inIncoming) return 'added-both';
    return inLocal ? 'added-local' : 'added-incoming';
  }
  if (!inLocal && !inIncoming) return 'deleted-both';
  if (inLocal && inIncoming) return 'common';
  const keptSideChanged = inLocal ? localChanged : incomingChanged;
  return keptSideChanged ? 'delete-conflict' : 'deleted-auto';
}

/* ------------------------------------------------------------------ */
/* 字段级三向合并                                                        */
/* ------------------------------------------------------------------ */

interface FieldConflictContext {
  level: 'project' | 'module' | 'step';
  conflictId: (field: string) => string;
  location: string;
  moduleId?: string;
  stepId?: string;
}

/**
 * 计算字段合并结果。
 * 分析阶段 onConflict 收集冲突；构建阶段 onConflict 返回已选边的值。
 */
function computeFields<T extends object>(
  baseObj: T | null,
  localObj: T,
  incomingObj: T,
  defs: FieldDef<T>[],
  context: FieldConflictContext,
  hooks: {
    onConflict: (conflict: FieldConflict) => MergeSide;
    onAutoChange?: (def: FieldDef<T>, source: MergeSide | 'both') => void;
  },
): Partial<T> {
  const merged: Partial<T> = {};
  for (const def of defs) {
    const localValue = localObj[def.key] as unknown;
    const incomingValue = incomingObj[def.key] as unknown;
    const baseValue = baseObj ? (baseObj[def.key] as unknown) : undefined;
    const hasBase = baseObj !== null;

    if (deepEqual(localValue, incomingValue)) {
      if (hasBase && !deepEqual(localValue, baseValue)) hooks.onAutoChange?.(def, 'both');
      merged[def.key] = localValue as T[keyof T & string];
      continue;
    }
    if (hasBase && deepEqual(localValue, baseValue)) {
      hooks.onAutoChange?.(def, 'incoming');
      merged[def.key] = incomingValue as T[keyof T & string];
      continue;
    }
    if (hasBase && deepEqual(incomingValue, baseValue)) {
      hooks.onAutoChange?.(def, 'local');
      merged[def.key] = localValue as T[keyof T & string];
      continue;
    }
    const resolution = hooks.onConflict({
      id: context.conflictId(def.key),
      kind: 'field',
      resolved: false,
      level: context.level,
      moduleId: context.moduleId,
      stepId: context.stepId,
      location: context.location,
      field: def.key,
      fieldLabel: def.label,
      baseValue: cloneData(baseValue),
      localValue: cloneData(localValue),
      incomingValue: cloneData(incomingValue),
    });
    merged[def.key] = (resolution === 'incoming' ? incomingValue : localValue) as T[keyof T & string];
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* 分析：单个模块（含步骤、字段、顺序、前置迁移）                          */
/* ------------------------------------------------------------------ */

interface ModuleAnalysis {
  conflicts: MergeConflict[];
  changes: MergeChange[];
}

function pickModuleTitle(baseMod: CourseModule | undefined, localMod: CourseModule | undefined, incomingMod: CourseModule | undefined): string {
  return localMod?.title ?? incomingMod?.title ?? baseMod?.title ?? '未命名模块';
}

function pickStepTitle(baseStep: LessonStep | undefined, localStep: LessonStep | undefined, incomingStep: LessonStep | undefined): string {
  return localStep?.title ?? incomingStep?.title ?? baseStep?.title ?? '未命名步骤';
}

function analyzeModule(
  moduleId: string,
  baseMod: CourseModule | undefined,
  localMod: CourseModule | undefined,
  incomingMod: CourseModule | undefined,
): ModuleAnalysis {
  const conflicts: MergeConflict[] = [];
  const changes: MergeChange[] = [];
  const moduleTitle = pickModuleTitle(baseMod, localMod, incomingMod);
  let changeSeq = 0;
  const changeId = (prefix: string) => `${moduleId}-${prefix}-${(changeSeq += 1)}`;
  const addChange = (level: 'module' | 'step', source: MergeChange['source'], message: string, stepId?: string) =>
    changes.push({ id: changeId(level), level, moduleId, stepId, source, message });

  const presence: Presence = { inBase: Boolean(baseMod), inLocal: Boolean(localMod), inIncoming: Boolean(incomingMod) };
  const status = classifyItem(
    presence,
    localMod ? !deepEqual(localMod, baseMod) : false,
    incomingMod ? !deepEqual(incomingMod, baseMod) : false,
  );

  /* 模块本身：一边删除、另一边修改 */
  if (status === 'delete-conflict') {
    const keepingSide: MergeSide = localMod ? 'local' : 'incoming';
    conflicts.push({
      id: `del-mod:${moduleId}`,
      kind: 'delete-modify',
      resolved: false,
      level: 'module',
      moduleId,
      location: `模块「${moduleTitle}」`,
      deletingSide: keepingSide === 'local' ? 'incoming' : 'local',
      keepingSide,
    });
    return { conflicts, changes };
  }

  /* 仅存在于一边：新增模块，整体并入 */
  if (!baseMod && (status === 'added-local' || status === 'added-incoming')) {
    const side = status === 'added-local' ? 'local' : 'incoming';
    const mod = (localMod ?? incomingMod) as CourseModule;
    addChange('module', side, `${sideLabel(side)}新增模块「${mod.title}」（含 ${mod.steps.length} 个步骤），已并入。`);
    return { conflicts, changes };
  }

  if (status === 'added-both' && localMod && incomingMod) {
    if (deepEqual(localMod, incomingMod)) {
      addChange('module', 'both', `两边都新增了相同的模块「${moduleTitle}」，已直接合并。`);
      return { conflicts, changes };
    }
    // 同一 id 两边各自新增且内容不同：字段级冲突继续往下走（baseMod 为 null）
  }

  /* 模块字段三向合并（baseMod 可能为 null：两边同 id 新增） */
  if (localMod && incomingMod) {
    computeFields(
      baseMod ?? null,
      localMod,
      incomingMod,
      MODULE_FIELDS,
      {
        level: 'module',
        conflictId: (field) => `field:${moduleId}::${field}`,
        location: `模块「${moduleTitle}」`,
        moduleId,
      },
      {
        onConflict: (conflict) => {
          conflicts.push(conflict);
          return 'local';
        },
        onAutoChange: (def, source) => {
          if (source === 'both') {
            addChange('module', 'both', `模块「${moduleTitle}」的${def.label}两边修改一致，已直接合并。`);
          } else {
            addChange('module', source, `模块「${moduleTitle}」的${def.label}采用${sideLabel(source)}的修改。`);
          }
        },
      },
    );
  }

  /* 步骤序列：顺序合并 + 单条状态判定 */
  const baseSteps = baseMod?.steps ?? [];
  const localSteps = localMod?.steps ?? [];
  const incomingSteps = incomingMod?.steps ?? [];
  const baseStepMap = stepMap(baseMod);
  const localStepMap = stepMap(localMod);
  const incomingStepMap = stepMap(incomingMod);

  const orderResult = mergeOrderedIds(
    baseSteps.map((step) => step.id),
    localSteps.map((step) => step.id),
    incomingSteps.map((step) => step.id),
  );

  if (orderResult.conflict) {
    const toEntry = (step: LessonStep): OrderEntry => ({ id: step.id, title: step.title });
    conflicts.push({
      id: `order-step:${moduleId}`,
      kind: 'order',
      resolved: false,
      level: 'step',
      moduleId,
      location: `模块「${moduleTitle}」的步骤顺序`,
      baseOrder: baseSteps.map(toEntry),
      localOrder: localSteps.map(toEntry),
      incomingOrder: incomingSteps.map(toEntry),
    });
  } else {
    const localMoved = !sameOrder(localSteps.map((s) => s.id), baseSteps.map((s) => s.id));
    const incomingMoved = !sameOrder(incomingSteps.map((s) => s.id), baseSteps.map((s) => s.id));
    if (localMoved || incomingMoved) {
      addChange('module', localMoved && !incomingMoved ? 'local' : 'incoming', `模块「${moduleTitle}」的步骤顺序有调整，已按调整后的顺序合并。`);
    }
  }

  for (const stepId of orderResult.order) {
    const b = baseStepMap.get(stepId);
    const l = localStepMap.get(stepId);
    const i = incomingStepMap.get(stepId);
    const stepTitle = pickStepTitle(b, l, i);
    const stepPresence: Presence = { inBase: Boolean(b), inLocal: Boolean(l), inIncoming: Boolean(i) };
    const stepStatus = classifyItem(
      stepPresence,
      l ? !deepEqual(l, b) : false,
      i ? !deepEqual(i, b) : false,
    );

    if (stepStatus === 'deleted-both') {
      addChange('step', 'both', `两边都删除了步骤「${stepTitle}」。`, stepId);
      continue;
    }
    if (stepStatus === 'deleted-auto') {
      const deletingSide: MergeSide = l ? 'incoming' : 'local';
      addChange('step', deletingSide, `${sideLabel(deletingSide)}删除了步骤「${stepTitle}」，另一边未改动，已删除。`, stepId);
      continue;
    }
    if (stepStatus === 'delete-conflict') {
      const keepingSide: MergeSide = l ? 'local' : 'incoming';
      conflicts.push({
        id: `del-step:${moduleId}:${stepId}`,
        kind: 'delete-modify',
        resolved: false,
        level: 'step',
        moduleId,
        stepId,
        location: `模块「${moduleTitle}」/ 步骤「${stepTitle}」`,
        deletingSide: keepingSide === 'local' ? 'incoming' : 'local',
        keepingSide,
      });
      continue;
    }
    if (stepStatus === 'added-local' || stepStatus === 'added-incoming') {
      const side = stepStatus === 'added-local' ? 'local' : 'incoming';
      addChange('step', side, `${sideLabel(side)}新增步骤「${stepTitle}」，已并入。`, stepId);
      continue;
    }

    // common 或 added-both：字段级三向合并
    if (l && i) {
      computeFields(
        b ?? null,
        l,
        i,
        STEP_FIELDS,
        {
          level: 'step',
          conflictId: (field) => `field:${moduleId}:${stepId}:${field}`,
          location: `模块「${moduleTitle}」/ 步骤「${stepTitle}」`,
          moduleId,
          stepId,
        },
        {
          onConflict: (conflict) => {
            conflicts.push(conflict);
            return 'local';
          },
          onAutoChange: (def, source) => {
            if (source === 'both') {
              addChange('step', 'both', `步骤「${stepTitle}」的${def.label}两边修改一致，已直接合并。`, stepId);
            } else {
              addChange('step', source, `步骤「${stepTitle}」的${def.label}采用${sideLabel(source)}的修改。`, stepId);
            }
          },
        },
      );
    }
  }

  /* 前置条件随步骤迁移：ID 不变，顺序变化后记录迁移说明 */
  const newIndex = new Map(orderResult.order.map((id, index) => [id, index]));
  const oldIndex = new Map(baseSteps.map((step, index) => [step.id, index]));
  const findStep = (id: string): LessonStep | undefined => localStepMap.get(id) ?? incomingStepMap.get(id) ?? baseStepMap.get(id);
  for (const stepId of orderResult.order) {
    const step = findStep(stepId);
    if (!step?.prerequisiteId) continue;
    const prerequisite = findStep(step.prerequisiteId);
    if (!prerequisite || !newIndex.has(step.prerequisiteId)) continue;
    const oldStep = oldIndex.get(stepId);
    const oldPre = oldIndex.get(step.prerequisiteId);
    const newStep = newIndex.get(stepId);
    const newPre = newIndex.get(step.prerequisiteId);
    if (oldStep === undefined || oldPre === undefined) continue;
    if (oldStep !== newStep || oldPre !== newPre) {
      addChange(
        'step',
        'system',
        `步骤「${step.title}」顺序调整后，前置条件仍指向步骤「${prerequisite.title}」，已随对应步骤迁移到新位置（#${(newPre ?? 0) + 1} → #${(newStep ?? 0) + 1}）。`,
        stepId,
      );
    }
  }

  return { conflicts, changes };
}

/* ------------------------------------------------------------------ */
/* 合并会话：创建、逐模块处理（可中断恢复）、选择、应用                     */
/* ------------------------------------------------------------------ */

export function createOfflinePackage(base: CourseProject, tablet: CourseProject, now: string = new Date().toISOString()): OfflinePackage {
  return {
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    exportedAt: now,
    projectId: base.id,
    teacher: base.teacher,
    baseRevision: base.revision,
    base: cloneData(base),
    tablet: cloneData(tablet),
  };
}

export function parseOfflinePackage(text: string): { ok: true; package: OfflinePackage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，无法识别为离线课程包。' };
  }
  const candidate = parsed as Partial<OfflinePackage>;
  if (!candidate || candidate.format !== PACKAGE_FORMAT) {
    return { ok: false, error: `文件格式不正确（期望 ${PACKAGE_FORMAT}）。` };
  }
  if (!candidate.base || !candidate.tablet || !Array.isArray(candidate.base.modules) || !Array.isArray(candidate.tablet.modules)) {
    return { ok: false, error: '离线包缺少课程快照或平板修改稿，内容不完整。' };
  }
  return { ok: true, package: candidate as OfflinePackage };
}

export interface StartMergeOptions {
  failAfterProcessed?: number;
  now?: string;
}

export function startMergeSession(local: CourseProject, pkg: OfflinePackage, options: StartMergeOptions = {}): MergeSession {
  const base = cloneData(pkg.base);
  const incoming = cloneData(pkg.tablet);
  const baseIds = base.modules.map((module) => module.id);
  const localIds = local.modules.map((module) => module.id);
  const incomingIds = incoming.modules.map((module) => module.id);
  const baseMap = moduleMap(base);
  const localMaps = moduleMap(local);
  const incomingMaps = moduleMap(incoming);

  const orderResult = mergeOrderedIds(baseIds, localIds, incomingIds);

  // 队列排除：两边都删、单边删除且另一边未改动（没有需要分析的内容）
  const queue = orderResult.order.filter((id) => {
    const presence: Presence = { inBase: baseMap.has(id), inLocal: localMaps.has(id), inIncoming: incomingMaps.has(id) };
    const b = baseMap.get(id);
    const l = localMaps.get(id);
    const i = incomingMaps.get(id);
    const status = classifyItem(
      presence,
      l ? !deepEqual(l, b) : false,
      i ? !deepEqual(i, b) : false,
    );
    return status !== 'deleted-both' && status !== 'deleted-auto';
  });

  const projectConflicts: MergeConflict[] = [];
  const changes: MergeChange[] = [];

  // 课程级字段三向合并
  computeFields(
    base,
    local,
    incoming,
    PROJECT_FIELDS,
    {
      level: 'project',
      conflictId: (field) => `field:project::${field}`,
      location: '课程信息',
    },
    {
      onConflict: (conflict) => {
        projectConflicts.push(conflict);
        return 'local';
      },
      onAutoChange: (def, source) => {
        changes.push({
          id: `project-${def.key}`,
          level: 'project',
          source,
          message: source === 'both'
            ? `课程${def.label}两边修改一致，已直接合并。`
            : `课程${def.label}采用${sideLabel(source)}的修改。`,
        });
      },
    },
  );

  // 模块顺序冲突
  if (orderResult.conflict) {
    const toEntry = (project: CourseProject, id: string): OrderEntry => {
      const module = project.modules.find((item) => item.id === id);
      return { id, title: module?.title ?? id };
    };
    projectConflicts.push({
      id: 'order-module',
      kind: 'order',
      resolved: false,
      level: 'module',
      location: '模块顺序',
      baseOrder: baseIds.map((id) => toEntry(base, id)),
      localOrder: localIds.map((id) => toEntry(local, id)),
      incomingOrder: incomingIds.map((id) => toEntry(incoming, id)),
    });
  }

  return {
    id: `merge-${Date.now().toString(36)}`,
    startedAt: options.now ?? new Date().toISOString(),
    packageExportedAt: pkg.exportedAt,
    baseRevision: pkg.baseRevision,
    base,
    local: cloneData(local),
    incoming,
    moduleQueue: queue,
    processedModuleIds: [],
    projectConflicts,
    conflicts: [],
    changes,
    analysisComplete: queue.length === 0,
    failAfterProcessed: options.failAfterProcessed,
  };
}

/** 处理下一个未处理的模块；幂等——已处理的模块不会重复产生冲突 */
export function processNextModule(session: MergeSession): MergeSession {
  const next = session.moduleQueue.find((id) => !session.processedModuleIds.includes(id));
  if (!next) {
    return { ...session, analysisComplete: true, lastError: undefined };
  }
  const baseMap = moduleMap(session.base);
  const localMap = moduleMap(session.local);
  const incomingMap = moduleMap(session.incoming);
  const analysis = analyzeModule(next, baseMap.get(next), localMap.get(next), incomingMap.get(next));

  return {
    ...session,
    processedModuleIds: [...session.processedModuleIds, next],
    conflicts: [...session.conflicts, ...analysis.conflicts],
    changes: [...session.changes, ...analysis.changes],
    analysisComplete: session.processedModuleIds.length + 1 >= session.moduleQueue.length,
  };
}

export interface ProcessOptions {
  /** 每处理完一个模块回调，界面在此持久化检查点 */
  onCheckpoint?: (session: MergeSession) => void;
}

/** 逐模块跑完分析；failAfterProcessed 到达时抛 MergeInterruptedError，检查点已落盘 */
export function processRemaining(session: MergeSession, options: ProcessOptions = {}): MergeSession {
  let current = session;
  for (;;) {
    const next = current.moduleQueue.find((id) => !current.processedModuleIds.includes(id));
    if (!next) {
      current = { ...current, analysisComplete: true, lastError: undefined };
      options.onCheckpoint?.(current);
      return current;
    }
    current = processNextModule(current);
    options.onCheckpoint?.(current);
    if (current.failAfterProcessed !== undefined && current.processedModuleIds.length >= current.failAfterProcessed && !current.analysisComplete) {
      const interrupted = { ...current, lastError: '导入在处理模块时中断，已处理模块和待选冲突已保留，可从中断处继续。' };
      options.onCheckpoint?.(interrupted);
      throw new MergeInterruptedError(interrupted.lastError);
    }
  }
}

export function allConflicts(session: MergeSession): MergeConflict[] {
  return [...session.projectConflicts, ...session.conflicts];
}

export function unresolvedConflicts(session: MergeSession): MergeConflict[] {
  return allConflicts(session).filter((conflict) => !conflict.resolved);
}

export function resolveConflict(session: MergeSession, conflictId: string, resolution: MergeSide | 'keep' | 'drop'): MergeSession {
  const apply = (conflict: MergeConflict): MergeConflict => {
    if (conflict.id !== conflictId) return conflict;
    if (conflict.kind === 'delete-modify') {
      return { ...conflict, resolution: resolution === 'keep' || resolution === 'drop' ? resolution : 'keep', resolved: true };
    }
    return { ...conflict, resolution: resolution === 'local' || resolution === 'incoming' ? resolution : 'local', resolved: true };
  };
  return {
    ...session,
    projectConflicts: session.projectConflicts.map(apply),
    conflicts: session.conflicts.map(apply),
  };
}

/* ------------------------------------------------------------------ */
/* 应用合并                                                             */
/* ------------------------------------------------------------------ */

export interface MergeApplication {
  project: CourseProject;
  notes: string[];
  conflictCount: number;
  changeCount: number;
}

function resolutionMap(session: MergeSession): Map<string, MergeSide | 'keep' | 'drop'> {
  const map = new Map<string, MergeSide | 'keep' | 'drop'>();
  for (const conflict of allConflicts(session)) {
    if (conflict.resolution) map.set(conflict.id, conflict.resolution);
  }
  return map;
}

function resolveFields<T extends object>(
  baseObj: T | null,
  localObj: T,
  incomingObj: T,
  defs: FieldDef<T>[],
  idPrefix: string,
  resolutions: Map<string, MergeSide | 'keep' | 'drop'>,
): T {
  const merged = computeFields(baseObj, localObj, incomingObj, defs, {
    level: 'step',
    conflictId: (field) => `${idPrefix}${field}`,
    location: '',
  }, {
    onConflict: (conflict) => resolutions.get(conflict.id) === 'incoming' ? 'incoming' : 'local',
  });
  return { ...localObj, ...merged };
}

function buildModule(
  baseMod: CourseModule | undefined,
  localMod: CourseModule | undefined,
  incomingMod: CourseModule | undefined,
  resolutions: Map<string, MergeSide | 'keep' | 'drop'>,
  notes: string[],
): CourseModule {
  const moduleId = (localMod ?? incomingMod ?? baseMod)!.id;

  // 模块字段
  let mergedModule: CourseModule;
  if (localMod && incomingMod) {
    mergedModule = resolveFields(baseMod ?? null, localMod, incomingMod, MODULE_FIELDS, `field:${moduleId}::`, resolutions) as CourseModule;
  } else {
    mergedModule = cloneData((localMod ?? incomingMod) as CourseModule);
  }

  const baseStepMap = stepMap(baseMod);
  const localStepMap = stepMap(localMod);
  const incomingStepMap = stepMap(incomingMod);
  const prefer = resolutions.get(`order-step:${moduleId}`) === 'incoming' ? 'incoming' : 'local';
  const order = mergeOrderedIds(
    (baseMod?.steps ?? []).map((step) => step.id),
    (localMod?.steps ?? []).map((step) => step.id),
    (incomingMod?.steps ?? []).map((step) => step.id),
    prefer,
  ).order;

  const steps: LessonStep[] = [];
  for (const stepId of order) {
    const b = baseStepMap.get(stepId);
    const l = localStepMap.get(stepId);
    const i = incomingStepMap.get(stepId);
    const presence: Presence = { inBase: Boolean(b), inLocal: Boolean(l), inIncoming: Boolean(i) };
    const status = classifyItem(
      presence,
      l ? !deepEqual(l, b) : false,
      i ? !deepEqual(i, b) : false,
    );
    if (status === 'deleted-both' || status === 'deleted-auto') continue;
    if (status === 'delete-conflict' && resolutions.get(`del-step:${moduleId}:${stepId}`) === 'drop') continue;

    if (l && i) {
      steps.push(resolveFields(b ?? null, l, i, STEP_FIELDS, `field:${moduleId}:${stepId}:`, resolutions));
    } else {
      steps.push(cloneData((l ?? i) as LessonStep));
    }
  }

  // 前置条件引用修复：目标步骤已不在模块中时清空引用，避免悬空依赖
  const stepIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    if (step.prerequisiteId && !stepIds.has(step.prerequisiteId)) {
      notes.push(`步骤「${step.title}」的前置步骤已被删除，前置条件已清空，请重新选择。`);
      step.prerequisiteId = '';
    }
  }

  return { ...mergedModule, steps };
}

export function buildMergedProject(session: MergeSession): MergeApplication {
  if (!session.analysisComplete) {
    throw new MergeInterruptedError('模块分析尚未完成，请先从中断处继续导入。');
  }
  const pending = unresolvedConflicts(session);
  if (pending.length > 0) {
    throw new Error(`仍有 ${pending.length} 处冲突未选择，全部选择后才能应用合并。`);
  }

  const resolutions = resolutionMap(session);
  const notes: string[] = [];
  const baseMap = moduleMap(session.base);
  const localMap = moduleMap(session.local);
  const incomingMap = moduleMap(session.incoming);

  // 课程字段
  const mergedProjectFields = resolveFields(session.base, session.local, session.incoming, PROJECT_FIELDS, 'field:project::', resolutions);

  // 模块顺序与增删
  const preferModuleOrder = resolutions.get('order-module') === 'incoming' ? 'incoming' : 'local';
  const moduleOrder = mergeOrderedIds(
    session.base.modules.map((module) => module.id),
    session.local.modules.map((module) => module.id),
    session.incoming.modules.map((module) => module.id),
    preferModuleOrder,
  ).order;

  const modules: CourseModule[] = [];
  for (const moduleId of moduleOrder) {
    const b = baseMap.get(moduleId);
    const l = localMap.get(moduleId);
    const i = incomingMap.get(moduleId);
    const presence: Presence = { inBase: Boolean(b), inLocal: Boolean(l), inIncoming: Boolean(i) };
    const status = classifyItem(
      presence,
      l ? !deepEqual(l, b) : false,
      i ? !deepEqual(i, b) : false,
    );
    if (status === 'deleted-both' || status === 'deleted-auto') continue;
    if (status === 'delete-conflict' && resolutions.get(`del-mod:${moduleId}`) === 'drop') continue;
    modules.push(buildModule(b, l, i, resolutions, notes));
  }

  // 选择项保持有效
  const selectedModuleId = modules.some((module) => module.id === session.local.selectedModuleId)
    ? session.local.selectedModuleId
    : modules[0]?.id ?? '';
  const selectedModule = modules.find((module) => module.id === selectedModuleId);
  const selectedStepId = selectedModule?.steps.some((step) => step.id === session.local.selectedStepId)
    ? session.local.selectedStepId
    : selectedModule?.steps[0]?.id ?? '';

  const project: CourseProject = {
    ...mergedProjectFields,
    status: 'draft',
    selectedModuleId,
    selectedStepId,
    modules,
    // 已冻结版本保持原样：完全保留电脑工作稿的冻结历史，不接受平板侧的冻结改动
    frozenVersions: cloneData(session.local.frozenVersions),
    lastSavedAt: new Date().toISOString(),
    revision: session.local.revision + 1,
  };

  return {
    project,
    notes,
    conflictCount: allConflicts(session).length,
    changeCount: session.changes.length,
  };
}

/* ------------------------------------------------------------------ */
/* 会话持久化                                                            */
/* ------------------------------------------------------------------ */

export function loadMergeSession(): MergeSession | undefined {
  try {
    const raw = localStorage.getItem(MERGE_SESSION_KEY);
    return raw ? JSON.parse(raw) as MergeSession : undefined;
  } catch {
    return undefined;
  }
}

export function saveMergeSession(session: MergeSession): void {
  localStorage.setItem(MERGE_SESSION_KEY, JSON.stringify(session));
}

export function clearMergeSession(): void {
  localStorage.removeItem(MERGE_SESSION_KEY);
}
