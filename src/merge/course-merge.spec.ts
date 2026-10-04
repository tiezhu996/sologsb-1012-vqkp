import { createDemoProject, type CourseProject, type CourseModule, type LessonStep } from '../models';
import {
  abortMerge,
  canCompleteMerge,
  completeMerge,
  createOfflinePackage,
  diffLines,
  driveMerge,
  formatFieldValue,
  MergeError,
  parseOfflinePackage,
  processNextModule,
  resolveConflict,
  retryFailedModule,
  skipFailedModule,
  startMergeSession,
  unresolvedConflicts,
  type MergeSession,
  type OfflineCoursePackage,
} from './course-merge';

/** 把课程处理成：modules 数 × steps 数，id 固定为 m{i} / m{i}s{j} */
function makeProject(modules: Array<{ steps: number }>): CourseProject {
  const project = createDemoProject();
  project.modules = modules.map((entry, moduleIndex) => ({
    id: `m${moduleIndex + 1}`,
    title: `模块${moduleIndex + 1}`,
    summary: `目标${moduleIndex + 1}`,
    color: '#000000',
    steps: Array.from({ length: entry.steps }, (_, stepIndex) => ({
      id: `m${moduleIndex + 1}s${stepIndex + 1}`,
      title: `步骤${moduleIndex + 1}-${stepIndex + 1}`,
      kind: '示范' as const,
      duration: 40,
      demoTitle: 'd',
      demoUrl: '',
      handshape: 'h',
      gestureZone: '中央' as const,
      caption: `字幕${moduleIndex + 1}-${stepIndex + 1}`,
      captionPosition: '下方安全区' as const,
      camera: '正面' as const,
      commonMistakes: [],
      exercise: '',
      exerciseFeedback: '',
      altText: `替代文本${moduleIndex + 1}-${stepIndex + 1}`,
      prerequisiteId: stepIndex === 0 ? '' : `m${moduleIndex + 1}s${stepIndex}`,
      difficulty: '入门' as const,
      cuePoints: [10],
    })),
  }));
  return project;
}

function makePackage(project: CourseProject): OfflineCoursePackage {
  const pkg = createOfflinePackage(project, '2026-10-01T00:00:00.000Z');
  return pkg;
}

function mutateProject(project: CourseProject, fn: (clone: CourseProject) => void): CourseProject {
  const next = structuredClone(project);
  fn(next);
  return next;
}

function getModule(session: MergeSession, moduleId: string): CourseModule {
  return session.provisionalModules.find((module) => module.id === moduleId)!;
}

function getStep(module: CourseModule, stepId: string): LessonStep {
  return module.steps.find((step) => step.id === stepId)!;
}

async function runAll(session: MergeSession): Promise<MergeSession> {
  const storage = new Map<string, MergeSession>();
  return driveMerge(session, (value) => storage.set('session', value));
}

describe('离线课程包合并', () => {
  describe('离线包导出与解析', () => {
    it('导出的包携带共同祖先和平板工作区', () => {
      const project = makeProject([{ steps: 2 }]);
      const pkg = makePackage(project);
      expect(pkg.format).toBe('signcourse-offline-package');
      expect(pkg.base.modules[0].steps).toHaveLength(2);
      expect(pkg.incoming.modules[0].steps).toHaveLength(2);
    });

    it('拒绝非 JSON、错误格式和错误版本的文件', () => {
      expect(() => parseOfflinePackage('{bad')).toThrow(MergeError);
      expect(() => parseOfflinePackage(JSON.stringify({ format: 'other' }))).toThrow(MergeError);
      expect(() => parseOfflinePackage(JSON.stringify({ format: 'signcourse-offline-package', formatVersion: '9', base: {}, incoming: {} }))).toThrow(MergeError);
    });

    it('拒绝来自其他课程的离线包', () => {
      const local = makeProject([{ steps: 1 }]);
      const tablet = makeProject([{ steps: 1 }]);
      tablet.id = 'another-course';
      const pkg = makePackage(tablet);
      expect(() => startMergeSession(local, pkg)).toThrow('其他课程');
    });

    it('冻结的工作稿不能直接合并', () => {
      const local = makeProject([{ steps: 1 }]);
      local.status = 'frozen';
      const pkg = makePackage(makeProject([{ steps: 1 }]));
      expect(() => startMergeSession(local, pkg)).toThrow('修订版');
    });
  });

  describe('不同位置自动合并', () => {
    it('电脑改字幕、平板改替代文本，两边改动直接进入结果', async () => {
      const base = makeProject([{ steps: 1 }]);
      const local = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '电脑改的字幕'; });
      const incoming = mutateProject(base, (p) => { p.modules[0].steps[0].altText = '平板改的替代文本'; });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      const step = getStep(getModule(session, 'm1'), 'm1s1');
      expect(step.caption).toBe('电脑改的字幕');
      expect(step.altText).toBe('平板改的替代文本');
      expect(unresolvedConflicts(session)).toHaveLength(0);
      expect(canCompleteMerge(session)).toBe(true);

      const merged = completeMerge(session);
      expect(merged.modules[0].steps[0].caption).toBe('电脑改的字幕');
      expect(merged.modules[0].steps[0].altText).toBe('平板改的替代文本');
    });

    it('两侧新增的不同步骤都保留，平板新增模块进入结果', async () => {
      const base = makeProject([{ steps: 1 }]);
      const local = mutateProject(base, (p) => {
        p.modules[0].steps.push({ ...structuredClone(p.modules[0].steps[0]), id: 'local-new', title: '电脑新增步骤' });
      });
      const incoming = mutateProject(base, (p) => {
        p.modules[0].steps.push({ ...structuredClone(p.modules[0].steps[0]), id: 'tablet-new', title: '平板新增步骤' });
        p.modules.push({ id: 'new-mod', title: '平板新模块', summary: 's', color: '#fff', steps: [] });
      });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      const module = getModule(session, 'm1');
      expect(module.steps.map((step) => step.id)).toEqual(expect.arrayContaining(['local-new', 'tablet-new']));
      expect(session.provisionalModules.some((item) => item.id === 'new-mod')).toBe(true);
      expect(unresolvedConflicts(session)).toHaveLength(0);
    });

    it('只有一侧删除且另一侧未改动时直接删除', async () => {
      const base = makeProject([{ steps: 2 }]);
      const local = base;
      const incoming = mutateProject(base, (p) => {
        p.modules[0].steps = p.modules[0].steps.filter((step) => step.id !== 'm1s2');
      });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      expect(getModule(session, 'm1').steps.map((step) => step.id)).toEqual(['m1s1']);
      expect(unresolvedConflicts(session)).toHaveLength(0);
    });
  });

  describe('同一位置双方改动 → 留两份待选', () => {
    it('字段两边都改产生冲突，选完之前不能完成合并', async () => {
      const base = makeProject([{ steps: 1 }]);
      const local = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '电脑字幕'; });
      const incoming = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '平板字幕'; });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      expect(session.status).toBe('awaiting-conflicts');
      expect(canCompleteMerge(session)).toBe(false);
      const conflict = unresolvedConflicts(session)[0];
      expect(conflict.kind).toBe('field');
      expect(conflict.field).toBe('caption');
      expect(conflict.localValue).toBe('电脑字幕');
      expect(conflict.incomingValue).toBe('平板字幕');
      expect(getStep(getModule(session, 'm1'), 'm1s1').caption).toBe('电脑字幕');

      const chosen = resolveConflict(session, conflict.id, 'incoming');
      expect(getStep(getModule(chosen, 'm1'), 'm1s1').caption).toBe('平板字幕');
      expect(canCompleteMerge(chosen)).toBe(true);
      const merged = completeMerge(chosen);
      expect(merged.modules[0].steps[0].caption).toBe('平板字幕');
    });

    it('一侧删除步骤另一侧修改步骤时保留待选，可选保留或删除', async () => {
      const base = makeProject([{ steps: 2 }]);
      const local = base;
      const incoming = mutateProject(base, (p) => {
        p.modules[0].steps = p.modules[0].steps.filter((step) => step.id !== 'm1s2');
      });
      const localEdited = mutateProject(local, (p) => { p.modules[0].steps[1].caption = '电脑还在改'; });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(localEdited, pkg));
      const conflict = session.conflicts.find((item) => item.kind === 'step-delete')!;
      expect(conflict).toBeTruthy();
      expect(conflict.deletedBy).toBe('incoming');

      const kept = resolveConflict(session, conflict.id, 'keep');
      expect(getModule(kept, 'm1').steps.map((step) => step.id)).toContain('m1s2');

      const removed = resolveConflict(session, conflict.id, 'delete');
      expect(getModule(removed, 'm1').steps.map((step) => step.id)).not.toContain('m1s2');
    });

    it('字段冲突中两边改成相同值时自动合并不产生冲突', async () => {
      const base = makeProject([{ steps: 1 }]);
      const local = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '同样的字幕'; });
      const incoming = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '同样的字幕'; });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      expect(unresolvedConflicts(session)).toHaveLength(0);
      expect(getStep(getModule(session, 'm1'), 'm1s1').caption).toBe('同样的字幕');
    });
  });

  describe('步骤顺序与前置条件迁移', () => {
    it('平板调整顺序且电脑未动时采用平板顺序，前置条件跟着步骤走', async () => {
      const base = makeProject([{ steps: 3 }]);
      // base: s1(无前置) s2(前置s1) s3(前置s2)
      const local = base;
      const incoming = mutateProject(base, (p) => {
        const steps = p.modules[0].steps;
        p.modules[0].steps = [steps[0], steps[2], steps[1]];
      });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      expect(getModule(session, 'm1').steps.map((step) => step.id)).toEqual(['m1s1', 'm1s3', 'm1s2']);
      // 前置条件仍指向同一个步骤（身份迁移），不会错位指向新位置上的步骤
      const mergedModule = completeMerge(session).modules[0];
      const s2 = getStep(mergedModule, 'm1s2');
      const s3 = getStep(mergedModule, 'm1s3');
      expect(s2.prerequisiteId).toBe('m1s1');
      expect(s3.prerequisiteId).toBe('m1s2');
      expect(session.notices.some((notice) => notice.type === 'reorder')).toBe(true);
    });

    it('两边都调整顺序且不一致时产生顺序冲突，可选择电脑或平板顺序', async () => {
      const base = makeProject([{ steps: 3 }]);
      const local = mutateProject(base, (p) => {
        const steps = p.modules[0].steps;
        p.modules[0].steps = [steps[2], steps[0], steps[1]];
      });
      const incoming = mutateProject(base, (p) => {
        const steps = p.modules[0].steps;
        p.modules[0].steps = [steps[1], steps[0], steps[2]];
      });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      const conflict = session.conflicts.find((item) => item.kind === 'step-order')!;
      expect(conflict).toBeTruthy();
      expect(canCompleteMerge(session)).toBe(false);

      const byLocal = resolveConflict(session, conflict.id, 'local');
      expect(getModule(byLocal, 'm1').steps.map((step) => step.id)).toEqual(['m1s3', 'm1s1', 'm1s2']);

      const byIncoming = resolveConflict(session, conflict.id, 'incoming');
      expect(getModule(byIncoming, 'm1').steps.map((step) => step.id)).toEqual(['m1s2', 'm1s1', 'm1s3']);
    });

    it('前置步骤被删除时悬空前置条件被清空并给出提示', async () => {
      const base = makeProject([{ steps: 2 }]);
      // s2 的前置是 s1；两边都未改 s2，但 s1 被平板删除、电脑改了 s1 → 选删除
      const localEdited = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '电脑改了s1'; });
      const incoming = mutateProject(base, (p) => {
        p.modules[0].steps = p.modules[0].steps.filter((step) => step.id !== 'm1s1');
      });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      let session = await runAll(startMergeSession(localEdited, pkg));
      const conflict = session.conflicts.find((item) => item.kind === 'step-delete')!;
      session = resolveConflict(session, conflict.id, 'delete');

      const mergedModule = completeMerge(session).modules[0];
      expect(mergedModule.steps.map((step) => step.id)).toEqual(['m1s2']);
      expect(mergedModule.steps[0].prerequisiteId).toBe('');
      expect(session.notices.some((notice) => notice.type === 'dangling-prerequisite')).toBe(true);
    });
  });

  describe('已冻结版本保持原样', () => {
    it('合并完成后 frozenVersions 不变', async () => {
      const base = makeProject([{ steps: 1 }]);
      base.frozenVersions = [
        { id: 'frozen-1', label: '冻结版本 v1', createdAt: '2026-09-01T00:00:00.000Z', snapshot: structuredClone({ ...base, frozenVersions: [] }) },
      ];
      const local = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '电脑字幕'; });
      const incoming = mutateProject(base, (p) => { p.modules[0].steps[0].altText = '平板替代'; });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      const merged = completeMerge(session);
      expect(merged.frozenVersions).toEqual(local.frozenVersions);
      expect(merged.frozenVersions[0].label).toBe('冻结版本 v1');
    });
  });

  describe('中断恢复', () => {
    it('逐模块处理：处理完第一个模块后中断，已处理模块和待选冲突都保留', () => {
      const base = makeProject([{ steps: 1 }, { steps: 1 }]);
      const local = mutateProject(base, (p) => {
        p.modules[0].steps[0].caption = '电脑字幕';
        p.modules[1].steps[0].caption = '电脑字幕2';
      });
      const incoming = mutateProject(base, (p) => {
        p.modules[0].steps[0].caption = '平板字幕';
        p.modules[1].steps[0].caption = '平板字幕2';
      });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      let session = startMergeSession(local, pkg);
      session = processNextModule(session);
      expect(session.processedModuleIds).toEqual(['m1']);
      expect(session.cursor).toBe(1);
      expect(session.provisionalModules).toHaveLength(1);
      expect(unresolvedConflicts(session)).toHaveLength(1);

      // 序列化到 localStorage 再恢复
      const saved = JSON.stringify(session);
      const restored = JSON.parse(saved) as MergeSession;
      const continued = processNextModule(restored);
      expect(continued.processedModuleIds).toEqual(['m1', 'm2']);
      expect(unresolvedConflicts(continued)).toHaveLength(2);
      expect(getStep(getModule(continued, 'm1'), 'm1s1').caption).toBe('电脑字幕');
    });

    it('模块数据损坏时会话中断，可重试或跳过并继续', () => {
      const base = makeProject([{ steps: 1 }, { steps: 1 }]);
      const pkg = makePackage(base);
      (pkg.incoming.modules[1] as unknown as { steps?: unknown }).steps = undefined;

      let session = startMergeSession(base, pkg);
      session = processNextModule(session);
      expect(session.status).toBe('processing');
      expect(session.processedModuleIds).toEqual(['m1']);
      session = processNextModule(session);
      expect(session.status).toBe('interrupted');
      expect(session.failedAt?.moduleId).toBe('m2');
      // 已处理的 m1 仍然保留
      expect(session.processedModuleIds).toEqual(['m1']);
      expect(() => completeMerge(session)).toThrow(MergeError);

      // 重试：数据仍损坏，依旧中断，进度不丢
      const retried = retryFailedModule(session);
      const again = processNextModule(retried);
      expect(again.status).toBe('interrupted');
      expect(again.processedModuleIds).toEqual(['m1']);

      // 跳过：保留电脑稿，继续到结束
      const skipped = skipFailedModule(again);
      expect(skipped.status).toBe('ready');
      expect(skipped.processedModuleIds).toEqual(['m1', 'm2']);
      expect(getModule(skipped, 'm2')).toBeTruthy();
      expect(skipped.notices.some((notice) => notice.type === 'skipped-module')).toBe(true);
      expect(canCompleteMerge(skipped)).toBe(true);
    });

    it('放弃合并后工作稿不受影响', async () => {
      const base = makeProject([{ steps: 1 }]);
      const local = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '电脑字幕'; });
      const incoming = mutateProject(base, (p) => { p.modules[0].steps[0].caption = '平板字幕'; });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      const session = await runAll(startMergeSession(local, pkg));
      const aborted = abortMerge(session);
      expect(aborted.status).toBe('aborted');
      // 未 completeMerge，local 快照不变
      expect(local.modules[0].steps[0].caption).toBe('电脑字幕');
    });
  });

  describe('教师真实工作流端到端', () => {
    it('电脑改前置条件，平板改字幕、调序、新增步骤；冲突逐处选择后并入', async () => {
      const base = makeProject([{ steps: 3 }]);
      // 电脑上：把 s3 的前置条件改成 s1
      const local = mutateProject(base, (p) => {
        p.modules[0].steps[2].prerequisiteId = 'm1s1';
        p.modules[0].steps[2].caption = '电脑同时改了字幕';
      });
      // 平板上：同样改了 s3 的字幕（不同内容），把 s2/s3 对调，新增一个练习步骤
      const incoming = mutateProject(base, (p) => {
        const steps = p.modules[0].steps;
        steps[2].caption = '平板改的字幕';
        p.modules[0].steps = [steps[0], steps[2], steps[1]];
        p.modules[0].steps.push({
          ...structuredClone(steps[0]),
          id: 'm1s4',
          title: '平板新增练习',
          kind: '练习',
          prerequisiteId: 'm1s3',
        });
      });
      const pkg = makePackage(base);
      pkg.incoming.modules = structuredClone(incoming.modules);

      let session = await runAll(startMergeSession(local, pkg));
      // 有冲突且不能提交/完成
      expect(canCompleteMerge(session)).toBe(false);
      const captionConflict = session.conflicts.find((c) => c.field === 'caption')!;
      session = resolveConflict(session, captionConflict.id, 'incoming');
      // 顺序冲突不存在（只有平板调序，电脑未动），自动采用平板顺序
      expect(session.conflicts.some((c) => c.kind === 'step-order')).toBe(false);

      const merged = completeMerge(session);
      const module = merged.modules[0];
      // 顺序：s1, s3, s2, s4（新增步骤排末尾，保留其在平板中的相对意图）
      expect(module.steps.map((s) => s.id)).toEqual(['m1s1', 'm1s3', 'm1s2', 'm1s4']);
      // 字幕选了平板
      expect(getStep(module, 'm1s3').caption).toBe('平板改的字幕');
      // 前置条件改动自动并入（电脑改的是不同字段）
      expect(getStep(module, 'm1s3').prerequisiteId).toBe('m1s1');
      // 新增步骤的前置条件指向的步骤仍可识别（身份迁移）
      expect(getStep(module, 'm1s4').prerequisiteId).toBe('m1s3');
      // 修订号推进、冻结版本字段未被引擎触碰
      expect(merged.revision).toBe(local.revision + 1);
    });
  });

  describe('差异展示辅助', () => {
    it('diffLines 标出新增和删除的行', () => {
      const segments = diffLines('第一行\n旧的第二行', '第一行\n新的第二行\n第三行');
      const types = segments.map((segment) => segment.type);
      expect(types).toContain('remove');
      expect(types).toContain('add');
      expect(segments.find((segment) => segment.type === 'add')?.text).toContain('新的第二行');
    });

    it('formatFieldValue 对数组字段和空前置条件做可读展示', () => {
      expect(formatFieldValue('cuePoints', [1, 2, 3])).toBe('1, 2, 3');
      expect(formatFieldValue('commonMistakes', ['错误一', '错误二'])).toBe('错误一\n错误二');
      expect(formatFieldValue('prerequisiteId', '')).toBe('无前置条件');
    });
  });
});
