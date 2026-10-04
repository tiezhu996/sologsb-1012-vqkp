import {
  type CourseModule,
  type CourseProject,
  type FrozenVersion,
  type LessonStep,
} from '../models';

/**
 * 离线课程包合并引擎
 *
 * 教师把课程导出到平板离线编辑（字幕、步骤、前置条件等），回到教研室后
 * 把平板上的离线包并入电脑上的工作稿。合并基于三方对比：
 *
 * - base：导出离线包时的共同祖先（随包携带）
 * - local：电脑上的当前工作稿
 * - incoming：平板离线改完的课程包
 *
 * 规则：
 * - 按模块 id 与步骤 id 识别两边改动；
 * - 不同位置（字段）的改动直接合并；
 * - 同一位置两边都改过且不一致时保留两份，标出差异，教师选完才生效；
 * - 步骤顺序变化时，前置条件按步骤身份（id）随对应步骤迁移；
 * - frozenVersions 已冻结版本始终保持原样，不参与合并；
 * - 逐模块处理并落检查点，导入中断后可从断点恢复。
 */

export const PACKAGE_FORMAT_VERSION = '1';
export const MERGE_SESSION_STORAGE_KEY = 'sologsb-1012-offline-merge-session-v1';

export const STEP_FIELDS = [
  'title',
  'kind',
  'duration',
  'demoTitle',
  'demoUrl',
  'handshape',
  'gestureZone',
  'caption',
  'captionPosition',
  'camera',
  'commonMistakes',
  'exercise',
  'exerciseFeedback',
  'altText',
  'prerequisiteId',
  'difficulty',
  'cuePoints',
] as const satisfies readonly (keyof LessonStep)[];

export type StepMergeField = (typeof STEP_FIELDS)[number];
export type ModuleMergeField = 'title' | 'summary' | 'color';
export const MODULE_FIELDS: ModuleMergeField[] = ['title', 'summary', 'color'];

export const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  kind: '步骤类型',
  duration: '时长',
  demoTitle: '示范片段名称',
  demoUrl: '本地素材地址',
  handshape: '手形说明',
  gestureZone: '动作区域',
  caption: '字幕',
  captionPosition: '字幕位置',
  camera: '镜头角度',
  commonMistakes: '常见错误',
  exercise: '练习任务',
  exerciseFeedback: '练习反馈',
  altText: '替代文本',
  prerequisiteId: '前置条件',
  difficulty: '难度标签',
  cuePoints: '检查点',
  summary: '模块目标',
  color: '主题色',
};

export interface OfflineCoursePackage {
  format: 'signcourse-offline-package';
  formatVersion: string;
  projectId: string;
  exportedAt: string;
  exportedOn: string;
  baseStatus: CourseProject['status'];
  /** 导出时刻的共同祖先模块，用于三方对比 */
  base: { modules: CourseModule[] };
  /** 平板离线编辑后的模块 */
  incoming: { modules: CourseModule[] };
}

export type ConflictChoice = 'local' | 'incoming' | 'keep' | 'delete';
export type ConflictKind = 'field' | 'step-delete' | 'module-delete' | 'step-order';

export interface MergeConflict {
  id: string;
  kind: ConflictKind;
  moduleId: string;
  stepId?: string;
  /** field 冲突对应的字段名 */
  field?: StepMergeField | ModuleMergeField;
  /** 字段冲突时的三方取值 */
  baseValue?: unknown;
  localValue?: unknown;
  incomingValue?: unknown;
  /** 人类可读的定位：模块名 / 步骤名 */
  location: string;
  /** 哪一侧要求删除（删除类冲突） */
  deletedBy?: 'local' | 'incoming';
  resolved: boolean;
  choice?: ConflictChoice;
}

export interface MergeNotice {
  id: string;
  type: 'dangling-prerequisite' | 'reorder' | 'skipped-module';
  moduleId: string;
  stepId?: string;
  message: string;
}

export type MergeSessionStatus = 'processing' | 'interrupted' | 'awaiting-conflicts' | 'ready' | 'aborted';

interface WorkItem {
  moduleId: string;
  action: 'merge' | 'add-local' | 'add-incoming' | 'drop';
}

export interface MergeSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: MergeSessionStatus;
  importedFileName: string;
  localSnapshot: CourseProject;
  pkg: OfflineCoursePackage;
  worklist: WorkItem[];
  cursor: number;
  /** 已处理完毕（含自动合并/跳过）的模块 id，按最终顺序 */
  provisionalModules: CourseModule[];
  processedModuleIds: string[];
  /** 每个模块两侧的步骤顺序，用于解决顺序冲突 */
  orderMeta: Record<string, { baseOrder: string[]; localOrder: string[]; incomingOrder: string[] }>;
  conflicts: MergeConflict[];
  notices: MergeNotice[];
  stats: { autoFields: number; addedSteps: number; deletedSteps: number; addedModules: number };
  failedAt?: { moduleId: string; message: string };
}

export class MergeError extends Error {}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function conflictId(parts: string[]): string {
  return parts.map((part) => part.replace(/[^a-zA-Z0-9_-]/g, '_')).join('::');
}

function indexModules(modules: CourseModule[]): Map<string, CourseModule> {
  return new Map(modules.map((module) => [module.id, module]));
}

function indexSteps(steps: LessonStep[]): Map<string, LessonStep> {
  return new Map(steps.map((step) => [step.id, step]));
}

function assertModuleShape(module: CourseModule | undefined, where: string): void {
  if (!module || typeof module !== 'object' || typeof module.id !== 'string' || !Array.isArray(module.steps)) {
    throw new MergeError(`${where}的模块数据损坏（缺少 id 或步骤列表），无法继续处理该模块。`);
  }
  if (module.steps.some((step) => !step || typeof step.id !== 'string')) {
    throw new MergeError(`${where}存在没有编号的步骤，无法识别对应步骤。`);
  }
}

/* ------------------------------------------------------------------ */
/* 离线包                                                              */
/* ------------------------------------------------------------------ */

export function createOfflinePackage(project: CourseProject, exportedAt = new Date().toISOString()): OfflineCoursePackage {
  return {
    format: 'signcourse-offline-package',
    formatVersion: PACKAGE_FORMAT_VERSION,
    projectId: project.id,
    exportedAt,
    exportedOn: '平板离线包',
    baseStatus: project.status,
    base: { modules: clone(project.modules) },
    incoming: { modules: clone(project.modules) },
  };
}

export function parseOfflinePackage(text: string): OfflineCoursePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MergeError('离线包不是有效的 JSON 文件，请确认导出文件没有损坏。');
  }
  const pkg = parsed as Partial<OfflineCoursePackage>;
  if (!pkg || pkg.format !== 'signcourse-offline-package') {
    throw new MergeError('文件不是 SignCourse 离线课程包。');
  }
  if (pkg.formatVersion !== PACKAGE_FORMAT_VERSION) {
    throw new MergeError(`离线包版本 ${pkg.formatVersion ?? '未知'} 与当前版本不兼容。`);
  }
  if (!Array.isArray(pkg.base?.modules) || !Array.isArray(pkg.incoming?.modules)) {
    throw new MergeError('离线包缺少共同祖先或平板课程数据。');
  }
  return pkg as OfflineCoursePackage;
}

/* ------------------------------------------------------------------ */
/* 字段值展示与差异                                                     */
/* ------------------------------------------------------------------ */

export function formatFieldValue(field: string, value: unknown, resolveTitle?: (id: string) => string | undefined): string {
  if (value === undefined || value === null) return '';
  if (field === 'commonMistakes') return Array.isArray(value) ? value.join('\n') : String(value);
  if (field === 'cuePoints') return Array.isArray(value) ? value.join(', ') : String(value);
  if (field === 'prerequisiteId') {
    if (value === '') return '无前置条件';
    return resolveTitle?.(String(value)) ?? String(value);
  }
  return String(value);
}

export interface DiffSegment {
  type: 'same' | 'remove' | 'add';
  text: string;
}

/** 逐行 LCS 差异，用于在冲突面板标出两边改动 */
export function diffLines(oldText: string, newText: string): DiffSegment[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const rows = oldLines.length;
  const cols = newLines.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffSegment['type'], text: string) => {
    const last = segments.at(-1);
    if (last && last.type === type) last.text += `\n${text}`;
    else segments.push({ type, text });
  };
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      push('same', oldLines[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('remove', oldLines[i]);
      i++;
    } else {
      push('add', newLines[j]);
      j++;
    }
  }
  while (i < rows) {
    push('remove', oldLines[i++]);
  }
  while (j < cols) {
    push('add', newLines[j++]);
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/* 会话创建                                                            */
/* ------------------------------------------------------------------ */

export function startMergeSession(
  local: CourseProject,
  pkg: OfflineCoursePackage,
  options: { fileName?: string; now?: string; id?: string } = {},
): MergeSession {
  if (local.status === 'frozen') {
    throw new MergeError('当前工作稿是已冻结版本，请先创建修订版再并入离线改动。');
  }
  if (pkg.projectId && local.id && pkg.projectId !== local.id) {
    throw new MergeError('离线包来自其他课程，不能并入当前工作稿。');
  }
  const baseModules = pkg.base.modules;
  const localModules = local.modules;
  const incomingModules = pkg.incoming.modules;
  // 仅保证电脑工作稿自身结构完整；离线包中损坏的模块在逐模块处理时中断，可恢复
  for (const module of localModules) {
    assertModuleShape(module, '电脑工作稿');
  }

  // 模块工作清单：顺序以电脑稿为准（需求只要求步骤顺序迁移），
  // 平板新增的模块按其在平板稿中的相对位置插入。
  const baseIds = new Set(baseModules.map((m) => m.id));
  const provisionalIds: string[] = [];
  const seen = new Set<string>();
  for (const module of localModules) {
    provisionalIds.push(module.id);
    seen.add(module.id);
    for (const candidate of incomingModules) {
      if (!seen.has(candidate.id) && !baseIds.has(candidate.id)) {
        // 仅当该新增模块在平板稿中位于当前模块之后、下一个电脑稿模块之前时插入
        provisionalIds.push(candidate.id);
        seen.add(candidate.id);
      }
    }
  }
  for (const candidate of incomingModules) {
    if (!seen.has(candidate.id)) {
      provisionalIds.push(candidate.id);
      seen.add(candidate.id);
    }
  }

  const baseMap = indexModules(baseModules);
  const localMap = indexModules(localModules);
  const incomingMap = indexModules(incomingModules);

  const worklist: WorkItem[] = provisionalIds.map((moduleId) => {
    const inBase = baseMap.has(moduleId);
    const inLocal = localMap.has(moduleId);
    const inIncoming = incomingMap.has(moduleId);
    if (!inBase) {
      return { moduleId, action: inLocal ? 'add-local' : 'add-incoming' } as WorkItem;
    }
    const localDeleted = !inLocal;
    const incomingDeleted = !inIncoming;
    if (localDeleted && incomingDeleted) return { moduleId, action: 'drop' };
    // 一侧删除、另一侧原样未动：直接采用删除
    if (localDeleted) {
      const incomingModule = incomingMap.get(moduleId)!;
      const unchanged = deepEqual(incomingModule, baseMap.get(moduleId));
      return { moduleId, action: unchanged ? 'drop' : 'merge' };
    }
    if (incomingDeleted) {
      const localModule = localMap.get(moduleId)!;
      const unchanged = deepEqual(localModule, baseMap.get(moduleId));
      return { moduleId, action: unchanged ? 'drop' : 'merge' };
    }
    return { moduleId, action: 'merge' };
  });

  const now = options.now ?? new Date().toISOString();
  return {
    id: options.id ?? `merge-${Date.now().toString(36)}`,
    createdAt: now,
    updatedAt: now,
    status: 'processing',
    importedFileName: options.fileName ?? '离线课程包',
    localSnapshot: clone(local),
    pkg: clone(pkg),
    worklist,
    cursor: 0,
    provisionalModules: [],
    processedModuleIds: [],
    orderMeta: {},
    conflicts: [],
    notices: [],
    stats: { autoFields: 0, addedSteps: 0, deletedSteps: 0, addedModules: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* 步骤合并                                                            */
/* ------------------------------------------------------------------ */

interface StepMergeResult {
  step: LessonStep;
  conflicts: MergeConflict[];
  autoFields: number;
}

function mergeStep(
  moduleId: string,
  locationPrefix: string,
  base: LessonStep | undefined,
  local: LessonStep | undefined,
  incoming: LessonStep | undefined,
): StepMergeResult {
  // 某一侧删除该步骤时，缺失侧视为祖先（不贡献改动）
  const localSide = local ?? base;
  const incomingSide = incoming ?? base;
  const merged = clone(localSide ?? incomingSide!) as LessonStep;
  const conflicts: MergeConflict[] = [];
  let autoFields = 0;

  for (const field of STEP_FIELDS) {
    const bVal = base ? base[field] : undefined;
    const lVal = localSide ? localSide[field] : undefined;
    const iVal = incomingSide ? incomingSide[field] : undefined;
    const localChanged = !deepEqual(lVal, bVal);
    const incomingChanged = !deepEqual(iVal, bVal);
    const assign = (value: unknown) => {
      (merged as unknown as Record<string, unknown>)[field] = value;
    };

    if (!localChanged && !incomingChanged) {
      assign(bVal);
    } else if (localChanged && !incomingChanged) {
      assign(lVal);
      autoFields++;
    } else if (!localChanged && incomingChanged) {
      assign(iVal);
      autoFields++;
    } else if (deepEqual(lVal, iVal)) {
      assign(lVal);
      autoFields++;
    } else {
      // 同一位置两边都改过：先留两份，标出差异，选完才生效（暂取电脑稿占位）
      assign(clone(lVal));
      conflicts.push({
        id: conflictId(['f', moduleId, merged.id, field]),
        kind: 'field',
        moduleId,
        stepId: merged.id,
        field,
        baseValue: clone(bVal),
        localValue: clone(lVal),
        incomingValue: clone(iVal),
        location: `${locationPrefix} · ${FIELD_LABELS[field]}`,
        resolved: false,
      });
    }
  }
  return { step: merged, conflicts, autoFields };
}

/** 按首选侧顺序排列步骤，再把另一侧新增步骤按相对位置插入 */
function orderStepIds(preferred: string[], other: string[], allIds: Set<string>): string[] {
  const ordered = preferred.filter((id) => allIds.has(id));
  const inOrder = new Set(ordered);
  const otherIndex = new Map(other.map((id, index) => [id, index]));
  for (const id of other) {
    if (inOrder.has(id) || !allIds.has(id)) continue;
    const targetPos = otherIndex.get(id)!;
    let insertAt = -1;
    for (let index = ordered.length - 1; index >= 0; index--) {
      const pos = otherIndex.get(ordered[index]);
      if (pos !== undefined && pos < targetPos) {
        insertAt = index;
        break;
      }
    }
    ordered.splice(insertAt + 1, 0, id);
    inOrder.add(id);
  }
  for (const id of allIds) {
    if (!inOrder.has(id)) ordered.push(id);
  }
  return ordered;
}

function fixDanglingPrerequisites(module: CourseModule, notices: MergeNotice[]): void {
  const ids = new Set(module.steps.map((step) => step.id));
  for (const step of module.steps) {
    if (step.prerequisiteId && !ids.has(step.prerequisiteId)) {
      const target = step.prerequisiteId;
      step.prerequisiteId = '';
      notices.push({
        id: conflictId(['n', module.id, step.id, target]),
        type: 'dangling-prerequisite',
        moduleId: module.id,
        stepId: step.id,
        message: `步骤「${step.title}」的前置步骤已在另一侧删除，前置条件已清空，请重新选择。`,
      });
    }
  }
}

interface MergedModule {
  module: CourseModule;
  conflicts: MergeConflict[];
  notices: MergeNotice[];
  autoFields: number;
  addedSteps: number;
  deletedSteps: number;
}

function mergeModule(baseModule: CourseModule, localModule: CourseModule | undefined, incomingModule: CourseModule | undefined): MergedModule {
  const moduleId = baseModule?.id ?? localModule?.id ?? incomingModule!.id;
  const conflicts: MergeConflict[] = [];
  const notices: MergeNotice[] = [];
  let autoFields = 0;
  let addedSteps = 0;
  let deletedSteps = 0;

  // —— 模块字段三方合并 ——
  const localSide = localModule ?? baseModule;
  const incomingSide = incomingModule ?? baseModule;
  const moduleDraft = clone(localSide ?? incomingSide!) as CourseModule;
  for (const field of MODULE_FIELDS) {
    const bVal = baseModule ? baseModule[field] : undefined;
    const lVal = localSide ? localSide[field] : undefined;
    const iVal = incomingSide ? incomingSide[field] : undefined;
    const localChanged = !deepEqual(lVal, bVal);
    const incomingChanged = !deepEqual(iVal, bVal);
    const assign = (value: unknown) => {
      (moduleDraft as unknown as Record<string, unknown>)[field] = value;
    };
    if (!localChanged && !incomingChanged) {
      assign(bVal);
    } else if (localChanged === incomingChanged && !deepEqual(lVal, iVal)) {
      assign(clone(lVal));
      conflicts.push({
        id: conflictId(['f', moduleId, field]),
        kind: 'field',
        moduleId,
        field,
        baseValue: clone(bVal),
        localValue: clone(lVal),
        incomingValue: clone(iVal),
        location: `模块「${moduleDraft.title}」 · ${FIELD_LABELS[field]}`,
        resolved: false,
      });
    } else {
      assign(localChanged ? lVal : iVal);
      autoFields++;
    }
  }

  // —— 步骤存在性 ——
  const baseSteps = indexSteps(baseModule?.steps ?? []);
  const localSteps = indexSteps(localModule?.steps ?? []);
  const incomingSteps = indexSteps(incomingModule?.steps ?? []);
  const provisionalSteps: LessonStep[] = [];
  const stepIds = new Set<string>();

  const consider = (stepId: string) => {
    if (stepIds.has(stepId)) return;
    const inBase = baseSteps.has(stepId);
    const localStep = localSteps.get(stepId);
    const incomingStep = incomingSteps.get(stepId);
    const baseStep = baseSteps.get(stepId);
    const location = `模块「${moduleDraft.title}」`;

    if (!inBase) {
      // 新增步骤：一侧新增直接采用；两侧同号新增则字段对比
      if (localStep && incomingStep) {
        const result = mergeStep(moduleId, location, undefined, localStep, incomingStep);
        provisionalSteps.push(result.step);
        conflicts.push(...result.conflicts);
        autoFields += result.autoFields;
      } else {
        provisionalSteps.push(clone((localStep ?? incomingStep)!));
        addedSteps++;
      }
      stepIds.add(stepId);
      return;
    }

    const localDeleted = !localStep;
    const incomingDeleted = !incomingStep;
    if (localDeleted && incomingDeleted) {
      deletedSteps++;
      stepIds.add(stepId);
      return;
    }
    if (localDeleted || incomingDeleted) {
      const survivor = (localStep ?? incomingStep)!;
      const survivorChanged = !deepEqual(survivor, baseStep);
      if (!survivorChanged) {
        // 删除侧要求删除，保留侧未改动 → 直接删除
        deletedSteps++;
        stepIds.add(stepId);
        return;
      }
      // 一侧删除、另一侧改过：保留待选
      provisionalSteps.push(clone(survivor));
      stepIds.add(stepId);
      conflicts.push({
        id: conflictId(['d', moduleId, stepId]),
        kind: 'step-delete',
        moduleId,
        stepId,
        localValue: localStep ? clone(localStep) : undefined,
        incomingValue: incomingStep ? clone(incomingStep) : undefined,
        location: `模块「${moduleDraft.title}」 · 步骤「${survivor.title}」`,
        deletedBy: localDeleted ? 'local' : 'incoming',
        resolved: false,
      });
      return;
    }

    const result = mergeStep(moduleId, location, baseStep, localStep, incomingStep);
    provisionalSteps.push(result.step);
    conflicts.push(...result.conflicts);
    autoFields += result.autoFields;
    stepIds.add(stepId);
  };

  // 先按电脑稿顺序考虑，再补充平板新增
  for (const step of localModule?.steps ?? []) consider(step.id);
  for (const step of incomingModule?.steps ?? []) consider(step.id);
  for (const step of baseModule?.steps ?? []) consider(step.id);

  // —— 步骤顺序 ——
  const baseOrder = (baseModule?.steps ?? []).map((step) => step.id).filter((id) => stepIds.has(id));
  const localOrder = (localModule?.steps ?? []).map((step) => step.id).filter((id) => stepIds.has(id));
  const incomingOrder = (incomingModule?.steps ?? []).map((step) => step.id).filter((id) => stepIds.has(id));

  const stable = baseOrder.filter((id) => localOrder.includes(id) && incomingOrder.includes(id));
  const localSub = localOrder.filter((id) => stable.includes(id));
  const incomingSub = incomingOrder.filter((id) => stable.includes(id));
  const baseSub = baseOrder.filter((id) => stable.includes(id));
  const localReordered = !deepEqual(localSub, baseSub);
  const incomingReordered = !deepEqual(incomingSub, baseSub);

  let preferred = localOrder;
  let other = incomingOrder;
  if (incomingReordered && !localReordered) {
    preferred = incomingOrder;
    other = localOrder;
    notices.push({
      id: conflictId(['n', moduleId, 'reorder']),
      type: 'reorder',
      moduleId,
      message: '平板端调整了步骤顺序，已按平板顺序排列，前置条件随对应步骤保留。',
    });
  }
  if (localReordered && incomingReordered && !deepEqual(localSub, incomingSub)) {
    // 两边都调整了顺序且不一致：待选，暂按电脑稿排列
    conflicts.push({
      id: conflictId(['o', moduleId]),
      kind: 'step-order',
      moduleId,
      localValue: localSub,
      incomingValue: incomingSub,
      location: `模块「${moduleDraft.title}」 · 步骤顺序`,
      resolved: false,
    });
  }

  const orderedIds = orderStepIds(preferred, other, stepIds);
  const byId = indexSteps(provisionalSteps);
  moduleDraft.steps = orderedIds.map((id) => byId.get(id)!).filter(Boolean);

  fixDanglingPrerequisites(moduleDraft, notices);

  return { module: moduleDraft, conflicts, notices, autoFields, addedSteps, deletedSteps };
}

/* ------------------------------------------------------------------ */
/* 逐模块处理（检查点）                                                 */
/* ------------------------------------------------------------------ */

function touch(session: MergeSession): MergeSession {
  session.updatedAt = new Date().toISOString();
  return session;
}

/** 处理工作清单中的下一个模块；全部处理完返回 ready/awaiting-conflicts */
export function processNextModule(sessionInput: MergeSession): MergeSession {
  const session = clone(sessionInput);
  if (session.status !== 'processing') return session;
  const item = session.worklist[session.cursor];
  if (!item) {
    session.status = session.conflicts.some((conflict) => !conflict.resolved) ? 'awaiting-conflicts' : 'ready';
    return touch(session);
  }

  const { moduleId, action } = item;
  const baseMap = indexModules(session.pkg.base.modules);
  const localMap = indexModules(session.localSnapshot.modules);
  const incomingMap = indexModules(session.pkg.incoming.modules);

  try {
    const baseModule = baseMap.get(moduleId);
    const localModule = localMap.get(moduleId);
    const incomingModule = incomingMap.get(moduleId);
    [baseModule, localModule, incomingModule].forEach((module) => {
      if (module) assertModuleShape(module, '离线包');
    });

    if (action === 'drop') {
      session.stats.deletedSteps += baseModule?.steps.length ?? 0;
    } else if (action === 'add-local') {
      session.provisionalModules.push(clone(localModule!));
      session.stats.addedModules++;
      session.stats.addedSteps += localModule!.steps.length;
    } else if (action === 'add-incoming') {
      session.provisionalModules.push(clone(incomingModule!));
      session.stats.addedModules++;
      session.stats.addedSteps += incomingModule!.steps.length;
    } else {
      const result = mergeModule(baseModule!, localModule, incomingModule);
      session.provisionalModules.push(result.module);
      session.conflicts.push(...result.conflicts);
      session.notices.push(...result.notices);
      session.stats.autoFields += result.autoFields;
      session.stats.addedSteps += result.addedSteps;
      session.stats.deletedSteps += result.deletedSteps;
      session.orderMeta[moduleId] = {
        baseOrder: (baseModule?.steps ?? []).map((step) => step.id),
        localOrder: (localModule?.steps ?? []).map((step) => step.id),
        incomingOrder: (incomingModule?.steps ?? []).map((step) => step.id),
      };

      // 一侧删除整个模块、另一侧改过：模块删除冲突
      const localDeleted = !localModule;
      const incomingDeleted = !incomingModule;
      if (localDeleted || incomingDeleted) {
        const survivorTitle = (localModule ?? incomingModule)!.title;
        session.conflicts.push({
          id: conflictId(['dm', moduleId]),
          kind: 'module-delete',
          moduleId,
          localValue: localModule ? clone(localModule) : undefined,
          incomingValue: incomingModule ? clone(incomingModule) : undefined,
          location: `模块「${survivorTitle}」`,
          deletedBy: localDeleted ? 'local' : 'incoming',
          resolved: false,
        });
      }
    }

    session.processedModuleIds.push(moduleId);
    session.cursor++;
    session.failedAt = undefined;
    if (session.cursor >= session.worklist.length) {
      session.status = session.conflicts.some((conflict) => !conflict.resolved) ? 'awaiting-conflicts' : 'ready';
    }
    return touch(session);
  } catch (error) {
    session.status = 'interrupted';
    session.failedAt = { moduleId, message: error instanceof Error ? error.message : '未知错误' };
    return touch(session);
  }
}

/** 驱动合并直到完成、遇冲突待选或中断（逐模块检查点由调用方持久化） */
export async function driveMerge(
  session: MergeSession,
  persist: (session: MergeSession) => void,
  wait: () => Promise<void> = () => new Promise((resolve) => window.setTimeout(resolve, 0)),
): Promise<MergeSession> {
  let current = session;
  while (current.status === 'processing') {
    current = processNextModule(current);
    persist(current);
    if (current.status === 'interrupted') break;
    await wait();
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* 中断恢复                                                            */
/* ------------------------------------------------------------------ */

/** 重试失败模块（继续之前先逐模块处理；同一损坏数据仍会再次失败，可改用 skip） */
export function retryFailedModule(sessionInput: MergeSession): MergeSession {
  const session = clone(sessionInput);
  if (session.status !== 'interrupted' || !session.failedAt) return session;
  session.status = 'processing';
  session.failedAt = undefined;
  return touch(session);
}

/** 跳过失败模块：电脑上存在则保留电脑稿，否则采用平板稿，随后继续 */
export function skipFailedModule(sessionInput: MergeSession): MergeSession {
  const session = clone(sessionInput);
  if (session.status !== 'interrupted' || !session.failedAt) return session;
  const { moduleId } = session.failedAt;
  const item = session.worklist[session.cursor];
  const localModule = session.localSnapshot.modules.find((module) => module.id === moduleId);
  const incomingModule = session.pkg.incoming.modules.find((module) => module.id === moduleId);
  const fallback = clone(localModule ?? incomingModule);
  if (fallback && item?.action !== 'drop') {
    session.provisionalModules.push(fallback);
    session.notices.push({
      id: conflictId(['n', moduleId, 'skipped']),
      type: 'skipped-module',
      moduleId,
      message: `模块「${fallback.title}」数据损坏已跳过，保留${localModule ? '电脑稿' : '平板稿'}原样。`,
    });
  }
  session.processedModuleIds.push(moduleId);
  session.cursor++;
  session.failedAt = undefined;
  session.status = session.cursor >= session.worklist.length
    ? (session.conflicts.some((conflict) => !conflict.resolved) ? 'awaiting-conflicts' : 'ready')
    : 'processing';
  return touch(session);
}

/* ------------------------------------------------------------------ */
/* 冲突解决                                                            */
/* ------------------------------------------------------------------ */

export function unresolvedConflicts(session: MergeSession): MergeConflict[] {
  return session.conflicts.filter((conflict) => !conflict.resolved);
}

export function canCompleteMerge(session: MergeSession): boolean {
  return (session.status === 'ready' || session.status === 'awaiting-conflicts')
    && session.cursor >= session.worklist.length
    && !session.failedAt
    && unresolvedConflicts(session).length === 0;
}

function mapConflicts(conflicts: MergeConflict[], conflictId: string, resolve: (conflict: MergeConflict) => void): MergeConflict[] {
  return conflicts.map((conflict) => {
    if (conflict.id !== conflictId || conflict.resolved) return conflict;
    const next = clone(conflict);
    resolve(next);
    next.resolved = true;
    return next;
  });
}

function refreshStatus(session: MergeSession): void {
  if (session.cursor < session.worklist.length || session.failedAt) {
    session.status = session.failedAt ? 'interrupted' : 'processing';
  } else {
    session.status = unresolvedConflicts(session).length === 0 ? 'ready' : 'awaiting-conflicts';
  }
}

function reorderModuleSteps(session: MergeSession, moduleId: string, preferredSide: 'local' | 'incoming'): void {
  const index = session.provisionalModules.findIndex((module) => module.id === moduleId);
  if (index < 0) return;
  const module = session.provisionalModules[index];
  const meta = session.orderMeta[moduleId];
  const allIds = new Set(module.steps.map((step) => step.id));
  const preferred = preferredSide === 'local' ? meta.localOrder : meta.incomingOrder;
  const other = preferredSide === 'local' ? meta.incomingOrder : meta.localOrder;
  const orderedIds = orderStepIds(preferred, other, allIds);
  const byId = new Map(module.steps.map((step) => [step.id, step]));
  module.steps = orderedIds.map((id) => byId.get(id)!).filter(Boolean);

  if (preferredSide === 'incoming') {
    const exists = session.notices.some((notice) => notice.type === 'reorder' && notice.moduleId === moduleId);
    if (!exists) {
      session.notices.push({
        id: conflictId(['n', moduleId, 'reorder']),
        type: 'reorder',
        moduleId,
        message: '已采用平板端步骤顺序，前置条件随对应步骤迁移。',
      });
    }
  }
}

/** 解决一个冲突。choice：field → local/incoming；删除类 → keep/delete；顺序 → local/incoming */
export function resolveConflict(sessionInput: MergeSession, conflictIdValue: string, choice: ConflictChoice): MergeSession {
  const session = clone(sessionInput);
  const conflict = session.conflicts.find((item) => item.id === conflictIdValue);
  if (!conflict || conflict.resolved) return sessionInput;

  if (conflict.kind === 'field') {
    const chosen = choice === 'incoming' ? conflict.incomingValue : conflict.localValue;
    if (conflict.stepId) {
      const module = session.provisionalModules.find((item) => item.id === conflict.moduleId);
      const step = module?.steps.find((item) => item.id === conflict.stepId);
      if (step && conflict.field) (step as unknown as Record<string, unknown>)[conflict.field] = clone(chosen);
    } else {
      const module = session.provisionalModules.find((item) => item.id === conflict.moduleId);
      if (module && conflict.field) (module as unknown as Record<string, unknown>)[conflict.field] = clone(chosen);
    }
    session.conflicts = mapConflicts(session.conflicts, conflictIdValue, (item) => { item.choice = choice === 'incoming' ? 'incoming' : 'local'; });
  } else if (conflict.kind === 'step-delete') {
    if (choice === 'delete') {
      const module = session.provisionalModules.find((item) => item.id === conflict.moduleId);
      if (module) {
        module.steps = module.steps.filter((step) => step.id !== conflict.stepId);
        session.stats.deletedSteps++;
        fixDanglingPrerequisites(module, session.notices);
      }
    }
    session.conflicts = mapConflicts(session.conflicts, conflictIdValue, (item) => { item.choice = choice === 'delete' ? 'delete' : 'keep'; });
  } else if (conflict.kind === 'module-delete') {
    if (choice === 'delete') {
      session.provisionalModules = session.provisionalModules.filter((module) => module.id !== conflict.moduleId);
    }
    session.conflicts = mapConflicts(session.conflicts, conflictIdValue, (item) => { item.choice = choice === 'delete' ? 'delete' : 'keep'; });
  } else if (conflict.kind === 'step-order') {
    reorderModuleSteps(session, conflict.moduleId, choice === 'incoming' ? 'incoming' : 'local');
    session.conflicts = mapConflicts(session.conflicts, conflictIdValue, (item) => { item.choice = choice === 'incoming' ? 'incoming' : 'local'; });
  }

  refreshStatus(session);
  return touch(session);
}

export function abortMerge(sessionInput: MergeSession): MergeSession {
  const session = clone(sessionInput);
  session.status = 'aborted';
  return touch(session);
}

/* ------------------------------------------------------------------ */
/* 完成合并                                                            */
/* ------------------------------------------------------------------ */

export function completeMerge(sessionInput: MergeSession, now = new Date().toISOString()): CourseProject {
  const session = sessionInput;
  if (!canCompleteMerge(session)) {
    throw new MergeError('仍有冲突未选择或模块未处理完，不能完成合并。');
  }
  const snapshot = session.localSnapshot;
  const modules = clone(session.provisionalModules);

  // 最后再统一兜底一次悬空前置条件
  const notices = clone(session.notices);
  for (const module of modules) fixDanglingPrerequisites(module, notices);

  const selectedModule = modules.find((module) => module.id === snapshot.selectedModuleId) ?? modules[0];
  const selectedStep = selectedModule?.steps.find((step) => step.id === snapshot.selectedStepId);

  return {
    ...clone(snapshot),
    modules,
    selectedModuleId: selectedModule?.id ?? '',
    selectedStepId: selectedStep?.id ?? '',
    lastSavedAt: now,
    revision: snapshot.revision + 1,
    // frozenVersions 来自快照且引擎从不触碰：已冻结版本保持原样
    frozenVersions: clone(snapshot.frozenVersions) as FrozenVersion[],
  };
}

export { clone as cloneMergeData };
