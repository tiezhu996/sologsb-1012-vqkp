import {
  allConflicts,
  buildMergedProject,
  clearMergeSession,
  createOfflinePackage,
  MergeInterruptedError,
  parseOfflinePackage,
  processNextModule,
  processRemaining,
  resolveConflict,
  saveMergeSession,
  startMergeSession,
  unresolvedConflicts,
  loadMergeSession,
  type OfflinePackage,
} from '../../merge';
import { createDemoProject, STORAGE_KEY, type CourseProject, type LessonStep } from '../../models';

function freshProject(): CourseProject {
  // 模型层默认键与合并测试无关，这里保证每个用例拿到独立深拷贝
  void STORAGE_KEY;
  return createDemoProject();
}

function patchStep(project: CourseProject, stepId: string, patch: Partial<LessonStep>): void {
  for (const module of project.modules) {
    const step = module.steps.find((item) => item.id === stepId);
    if (step) Object.assign(step, patch);
  }
}

function findStep(project: CourseProject, stepId: string): LessonStep | undefined {
  for (const module of project.modules) {
    const step = module.steps.find((item) => item.id === stepId);
    if (step) return step;
  }
  return undefined;
}

function makePackage(base: CourseProject, tablet: CourseProject): OfflinePackage {
  return createOfflinePackage(base, tablet, '2026-10-04T10:00:00.000Z');
}

describe('离线课程包解析', () => {
  it('合法离线包可以往返序列化解析', () => {
    const base = freshProject();
    const tablet = freshProject();
    const pkg = makePackage(base, tablet);
    const parsed = parseOfflinePackage(JSON.stringify(pkg));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.package.format).toBe('signcourse-offline-package');
      expect(parsed.package.base.modules.length).toBe(2);
    }
  });

  it('损坏的 JSON 或错误格式返回可读错误', () => {
    expect(parseOfflinePackage('{bad json').ok).toBe(false);
    const wrong = parseOfflinePackage(JSON.stringify({ format: 'something-else' }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('格式');
  });
});

describe('不同位置改动直接合并', () => {
  it('两边修改不同步骤的字幕时不产生冲突，两边改动都进入合并稿', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    patchStep(local, 'step-1-1', { caption: '电脑端修订了第一步骤字幕' });
    patchStep(tablet, 'step-1-2', { caption: '平板离线修订了第二步骤字幕' });

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    expect(unresolvedConflicts(session)).toHaveLength(0);

    const merged = buildMergedProject(session).project;
    expect(findStep(merged, 'step-1-1')?.caption).toBe('电脑端修订了第一步骤字幕');
    expect(findStep(merged, 'step-1-2')?.caption).toBe('平板离线修订了第二步骤字幕');
  });

  it('同一位置一边修改、另一边未改时直接采用修改方', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    patchStep(tablet, 'step-2-1', { altText: '平板补充的替代文本描述动作与表情' });

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    expect(allConflicts(session)).toHaveLength(0);
    const merged = buildMergedProject(session).project;
    expect(findStep(merged, 'step-2-1')?.altText).toBe('平板补充的替代文本描述动作与表情');
  });

  it('两边新增到不同位置的步骤都会并入', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    const localStep: LessonStep = {
      ...local.modules[0].steps[0],
      id: 'step-local-new',
      title: '电脑新增步骤',
      prerequisiteId: '',
    };
    const tabletStep: LessonStep = {
      ...tablet.modules[0].steps[0],
      id: 'step-tablet-new',
      title: '平板新增步骤',
      prerequisiteId: '',
    };
    local.modules[0].steps.push(localStep);
    tablet.modules[0].steps.push(tabletStep);

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const merged = buildMergedProject(session).project;
    const titles = merged.modules[0].steps.map((step) => step.title);
    expect(titles).toContain('电脑新增步骤');
    expect(titles).toContain('平板新增步骤');
  });
});

describe('同一位置两边都改', () => {
  it('两边改动内容不同时保留两份并标出字段级差异，选完之前不能应用', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    patchStep(local, 'step-1-1', { caption: '电脑改的字幕' });
    patchStep(tablet, 'step-1-1', { caption: '平板改的字幕' });

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const conflicts = unresolvedConflicts(session);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('field');
    if (conflicts[0].kind === 'field') {
      expect(conflicts[0].fieldLabel).toBe('字幕');
      expect(conflicts[0].localValue).toBe('电脑改的字幕');
      expect(conflicts[0].incomingValue).toBe('平板改的字幕');
      expect(conflicts[0].resolved).toBe(false);
    }

    expect(() => buildMergedProject(session)).toThrow(/未选择/);
  });

  it('选择平板版本后冲突解决，应用时采用平板值', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    patchStep(local, 'step-1-1', { caption: '电脑改的字幕' });
    patchStep(tablet, 'step-1-1', { caption: '平板改的字幕' });

    let session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const conflictId = unresolvedConflicts(session)[0].id;
    session = resolveConflict(session, conflictId, 'incoming');
    expect(unresolvedConflicts(session)).toHaveLength(0);

    const merged = buildMergedProject(session).project;
    expect(findStep(merged, 'step-1-1')?.caption).toBe('平板改的字幕');
  });

  it('两边改动内容一致时直接合并，不算冲突', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    patchStep(local, 'step-1-1', { caption: '两边改成一样' });
    patchStep(tablet, 'step-1-1', { caption: '两边改成一样' });

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    expect(allConflicts(session)).toHaveLength(0);
    const merged = buildMergedProject(session).project;
    expect(findStep(merged, 'step-1-1')?.caption).toBe('两边改成一样');
  });

  it('前置条件两边改成不同步骤时保留两份供选择', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    patchStep(local, 'step-1-3', { prerequisiteId: 'step-1-1' });
    patchStep(tablet, 'step-1-3', { prerequisiteId: '' });

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const fieldConflicts = allConflicts(session).filter((conflict) => conflict.kind === 'field');
    const preConflict = fieldConflicts.find((conflict) => conflict.kind === 'field' && conflict.field === 'prerequisiteId');
    expect(preConflict).toBeDefined();
    expect(preConflict?.resolved).toBe(false);
  });
});

describe('步骤顺序与前置条件迁移', () => {
  it('只有一边调整顺序时采用新顺序，前置条件随对应步骤迁移且仍指向同一前置步骤', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    // 平板把 1-3 移到 1-2 之前：[1-1, 1-3, 1-2]
    const steps = tablet.modules[0].steps;
    const [first, second, third] = steps;
    tablet.modules[0].steps = [first, third, second];

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    expect(allConflicts(session).filter((c) => c.kind === 'order')).toHaveLength(0);

    const merged = buildMergedProject(session).project;
    const ids = merged.modules[0].steps.map((step) => step.id);
    expect(ids).toEqual(['step-1-1', 'step-1-3', 'step-1-2']);
    // 前置条件没有被错误重指：1-2 仍以 1-1 为前置，1-3 仍以 1-2 为前置
    expect(findStep(merged, 'step-1-2')?.prerequisiteId).toBe('step-1-1');
    expect(findStep(merged, 'step-1-3')?.prerequisiteId).toBe('step-1-2');
    // 迁移说明已记录
    expect(session.changes.some((change) => change.message.includes('迁移'))).toBe(true);
  });

  it('两边都调顺序且结果不同时产生顺序冲突，选择后才生效', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    // 电脑：[1-2, 1-1, 1-3]；平板：[1-3, 1-1, 1-2]
    local.modules[0].steps = [base.modules[0].steps[1], base.modules[0].steps[0], base.modules[0].steps[2]];
    tablet.modules[0].steps = [base.modules[0].steps[2], base.modules[0].steps[0], base.modules[0].steps[1]];

    let session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const orderConflict = allConflicts(session).find((conflict) => conflict.kind === 'order' && conflict.level === 'step');
    expect(orderConflict).toBeDefined();
    expect(orderConflict?.resolved).toBe(false);

    session = resolveConflict(session, orderConflict!.id, 'incoming');
    const merged = buildMergedProject(session).project;
    expect(merged.modules[0].steps.map((step) => step.id)).toEqual(['step-1-3', 'step-1-1', 'step-1-2']);
  });
});

describe('删除与修改冲突', () => {
  it('一边删除、另一边未改动时直接删除', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    tablet.modules[0].steps = tablet.modules[0].steps.filter((step) => step.id !== 'step-1-2');

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    expect(allConflicts(session)).toHaveLength(0);
    const merged = buildMergedProject(session).project;
    expect(merged.modules[0].steps.some((step) => step.id === 'step-1-2')).toBe(false);
  });

  it('一边删除、另一边修改时要求选择，选保留则步骤保留且带修改，选删除则移除', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    tablet.modules[0].steps = tablet.modules[0].steps.filter((step) => step.id !== 'step-1-2');
    patchStep(local, 'step-1-2', { caption: '电脑还在修改这一步' });

    let session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const conflict = allConflicts(session).find((item) => item.kind === 'delete-modify');
    expect(conflict).toBeDefined();
    expect(() => buildMergedProject(session)).toThrow();

    session = resolveConflict(session, conflict!.id, 'keep');
    let merged = buildMergedProject(session).project;
    expect(findStep(merged, 'step-1-2')?.caption).toBe('电脑还在修改这一步');

    session = resolveConflict(session, conflict!.id, 'drop');
    merged = buildMergedProject(session).project;
    expect(merged.modules[0].steps.some((step) => step.id === 'step-1-2')).toBe(false);
  });

  it('前置步骤被单边删除时，悬空的前置条件会被清空并给出说明', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    tablet.modules[0].steps = tablet.modules[0].steps.filter((step) => step.id !== 'step-1-2');

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const result = buildMergedProject(session);
    expect(findStep(result.project, 'step-1-3')?.prerequisiteId).toBe('');
    expect(result.notes.some((note) => note.includes('前置步骤已被删除'))).toBe(true);
  });
});

describe('课程与模块级合并', () => {
  it('课程标题两边都改成不同内容时产生课程级冲突', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    local.title = '电脑改的课程标题';
    tablet.title = '平板改的课程标题';

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const conflict = allConflicts(session).find((item) => item.kind === 'field' && item.level === 'project' && item.field === 'title');
    expect(conflict).toBeDefined();
  });

  it('一边新增模块、另一边未动时整体并入', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    tablet.modules.push({
      id: 'module-tablet-3',
      title: '模块三 · 平板新增',
      summary: '离线新增的模块',
      color: '#b34331',
      steps: [],
    });

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    expect(allConflicts(session)).toHaveLength(0);
    const merged = buildMergedProject(session).project;
    expect(merged.modules.some((module) => module.id === 'module-tablet-3')).toBe(true);
  });
});

describe('冻结版本保持原样', () => {
  it('合并只动工作稿，电脑工作稿的冻结版本完整保留，不采用平板侧冻结历史', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    local.frozenVersions = [
      { id: 'frozen-local', label: '电脑冻结版本 v1', createdAt: '2026-09-01T08:00:00.000Z', snapshot: (() => { const { frozenVersions: _ignored, ...snapshot } = local; void _ignored; return snapshot; })() },
    ];
    tablet.frozenVersions = [
      { id: 'frozen-tablet', label: '平板侧的冻结快照', createdAt: '2026-09-02T08:00:00.000Z', snapshot: (() => { const { frozenVersions: _ignored, ...snapshot } = tablet; void _ignored; return snapshot; })() },
    ];
    patchStep(tablet, 'step-1-1', { caption: '平板改了字幕' });

    const session = processRemaining(startMergeSession(local, makePackage(base, tablet)));
    const merged = buildMergedProject(session).project;
    expect(merged.frozenVersions.map((version) => version.id)).toEqual(['frozen-local']);
    expect(merged.status).toBe('draft');
  });
});

describe('导入中断后从检查点恢复', () => {
  it('处理到第二个模块前中断：已处理模块的冲突与待选选择不丢失、不重复，恢复后继续', () => {
    const base = freshProject();
    const local = freshProject();
    const tablet = freshProject();
    // 两个模块都产生字段冲突，保证队列中至少两个待处理模块
    patchStep(local, 'step-1-1', { caption: '电脑-模块一' });
    patchStep(tablet, 'step-1-1', { caption: '平板-模块一' });
    patchStep(local, 'step-2-1', { caption: '电脑-模块二' });
    patchStep(tablet, 'step-2-1', { caption: '平板-模块二' });

    let checkpoint: ReturnType<typeof processNextModule> | undefined;
    const started = startMergeSession(local, makePackage(base, tablet), { failAfterProcessed: 1 });
    expect(() => {
      processRemaining(started, { onCheckpoint: (current) => { checkpoint = current; } });
    }).toThrow(MergeInterruptedError);

    expect(checkpoint).toBeDefined();
    expect(checkpoint!.processedModuleIds).toHaveLength(1);
    expect(checkpoint!.analysisComplete).toBe(false);
    expect(checkpoint!.lastError).toContain('中断');

    // 模拟刷新后从 localStorage 恢复
    saveMergeSession(checkpoint!);
    const restored = loadMergeSession()!;
    expect(restored.processedModuleIds).toHaveLength(1);

    // 先对已分析模块的冲突做出选择
    const resolved = resolveConflict(restored, unresolvedConflicts(restored)[0].id, 'local');
    const completed = processRemaining(resolved);
    expect(completed.analysisComplete).toBe(true);
    expect(completed.processedModuleIds).toHaveLength(2);

    // 两个模块各一个字段冲突，且第一个模块的选择被保留
    expect(allConflicts(completed)).toHaveLength(2);
    const chosen = allConflicts(completed).filter((conflict) => conflict.resolved);
    expect(chosen).toHaveLength(1);

    // 未处理完的冲突仍阻止应用；全部选择后成功
    expect(() => buildMergedProject(completed)).toThrow();
    const remaining = unresolvedConflicts(completed)[0];
    const finalSession = resolveConflict(completed, remaining.id, 'incoming');
    const result = buildMergedProject(finalSession);
    expect(result.project.modules.length).toBe(2);
    expect(findStep(result.project, 'step-2-1')?.caption).toBe('平板-模块二');
    clearMergeSession();
  });
});
