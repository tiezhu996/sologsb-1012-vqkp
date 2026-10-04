import { Component, Host, State, h, Listen } from '@stencil/core';
import {
  cloneProject,
  createDemoProject,
  selectedModule,
  selectedStep,
  STORAGE_KEY,
  validateProject,
  type CameraAngle,
  type CaptionPosition,
  type CourseModule,
  type CourseProject,
  type Difficulty,
  type GestureZone,
  type LessonStep,
  type ValidationCheck,
} from '../../models';
import {
  allConflicts,
  buildMergedProject,
  clearMergeSession,
  createOfflinePackage,
  DEVICE_MODE_KEY,
  formatFieldValue,
  INCOMING_SIDE_LABEL,
  LOCAL_SIDE_LABEL,
  loadMergeSession,
  MergeInterruptedError,
  OFFLINE_PACKAGE_KEY,
  parseOfflinePackage,
  processRemaining,
  resolveConflict,
  saveMergeSession,
  startMergeSession,
  TABLET_BASE_KEY,
  TABLET_STORAGE_KEY,
  unresolvedConflicts,
  type MergeConflict,
  type MergeSession,
  type MergeSide,
} from '../../merge';

type PreviewSize = 'phone' | 'tablet';
type DeviceMode = 'desktop' | 'tablet';

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  @State() project: CourseProject = createDemoProject();
  @State() previewSize: PreviewSize = 'phone';
  @State() activePanel: 'editor' | 'checks' = 'editor';
  @State() playing = false;
  @State() playProgress = 0;
  @State() offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  @State() toast?: { color: string; message: string };
  @State() deviceMode: DeviceMode = 'desktop';
  @State() mergeModalOpen = false;
  @State() mergeSession?: MergeSession;
  @State() mergeImportError?: string;
  @State() mergeFailAfter = 0;
  @State() mergeApplyNotes: string[] = [];
  private past: CourseProject[] = [];
  private future: CourseProject[] = [];
  private playTimer?: number;
  private fileInput?: HTMLInputElement;

  componentWillLoad(): void {
    try {
      this.deviceMode = (localStorage.getItem(DEVICE_MODE_KEY) as DeviceMode) === 'tablet' ? 'tablet' : 'desktop';
      const saved = localStorage.getItem(this.storageKey);
      if (saved) this.project = JSON.parse(saved) as CourseProject;
      this.mergeSession = loadMergeSession();
    } catch {
      this.project = createDemoProject();
    }
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
  }

  private get storageKey(): string {
    return this.deviceMode === 'tablet' ? TABLET_STORAGE_KEY : STORAGE_KEY;
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.offline = false;
    this.showToast('success', '网络已恢复，本地草稿无需合并即可继续编辑。');
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.offline = true;
    this.showToast('warning', '当前处于离线状态，修改会继续保存在本机。');
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    if (this.mergeModalOpen) return;
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.saveDraft(true);
      return;
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.moveStep(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  private get currentModule(): CourseModule {
    return selectedModule(this.project);
  }

  private get currentStep(): LessonStep | undefined {
    return selectedStep(this.project);
  }

  private get checks(): ValidationCheck[] {
    return validateProject(this.project);
  }

  private get pendingMerge(): boolean {
    return this.deviceMode === 'desktop' && Boolean(this.mergeSession);
  }

  private get pendingConflictCount(): number {
    return this.mergeSession ? unresolvedConflicts(this.mergeSession).length : 0;
  }

  private persist(): void {
    localStorage.setItem(this.storageKey, JSON.stringify(this.project));
  }

  private commit(update: (draft: CourseProject) => CourseProject, toast?: string): void {
    if (this.pendingMerge) {
      this.showToast('warning', '有未完成的离线合并，请先处理完冲突或放弃合并后再编辑。');
      return;
    }
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const before = cloneProject(this.project);
    const next = update(cloneProject(this.project));
    next.revision = before.revision + 1;
    next.lastSavedAt = new Date().toISOString();
    this.past = [...this.past, before].slice(-80);
    this.future = [];
    this.project = next;
    this.persist();
    if (toast) this.showToast('success', toast);
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.showToast('medium', '没有可撤销的修改。');
    this.future = [cloneProject(this.project), ...this.future].slice(0, 80);
    this.project = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneProject(this.project)].slice(-80);
    this.project = next;
    this.persist();
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_200);
  }

  /* ---------------------------------------------------------------- */
  /* 设备模式与离线包                                                   */
  /* ---------------------------------------------------------------- */

  private switchDeviceMode(mode: DeviceMode): void {
    if (mode === this.deviceMode) return;
    if (this.deviceMode === 'desktop' && this.mergeSession) {
      this.showToast('warning', '有未完成的离线合并，请先处理完或放弃合并后再切换设备。');
      return;
    }
    this.deviceMode = mode;
    localStorage.setItem(DEVICE_MODE_KEY, mode);
    this.past = [];
    this.future = [];
    this.playing = false;
    this.activePanel = 'editor';
    try {
      const saved = localStorage.getItem(this.storageKey);
      this.project = saved ? JSON.parse(saved) as CourseProject : createDemoProject();
    } catch {
      this.project = createDemoProject();
    }
    if (mode === 'tablet') {
      localStorage.setItem(TABLET_BASE_KEY, JSON.stringify(cloneProject(this.project)));
      this.showToast('success', '已进入平板离线工作台：修改字幕、步骤和前置条件后，可导出离线包带回电脑。');
    } else {
      this.mergeSession = loadMergeSession();
      this.showToast('medium', '已回到电脑工作稿。');
    }
  }

  private exportOfflinePackage(): void {
    if (this.deviceMode === 'desktop' && this.project.status === 'frozen') {
      this.showToast('warning', '冻结版本保持原样，不支持从冻结版本导出离线包。');
      return;
    }
    const base = (() => {
      if (this.deviceMode === 'tablet') {
        try {
          const savedBase = localStorage.getItem(TABLET_BASE_KEY);
          if (savedBase) return JSON.parse(savedBase) as CourseProject;
        } catch {
          /* 回退到当前快照 */
        }
      }
      return cloneProject(this.project);
    })();
    const pkg = createOfflinePackage(base, this.project);
    const json = JSON.stringify(pkg, null, 2);

    // 本机模拟：供电脑模式直接读取，免文件选择也能演示完整流程
    localStorage.setItem(OFFLINE_PACKAGE_KEY, json);

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `offline-course-package-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.showToast('success', this.deviceMode === 'tablet'
      ? '离线课程包已导出，回到电脑工作稿后可导入合并。'
      : '离线课程包已导出，可拷到平板离线编辑。');
  }

  private openMergeModal(): void {
    this.mergeImportError = undefined;
    this.mergeApplyNotes = [];
    this.mergeModalOpen = true;
  }

  private closeMergeModal(): void {
    this.mergeModalOpen = false;
    this.mergeImportError = undefined;
  }

  private triggerPackageFile(): void {
    this.mergeImportError = undefined;
    this.fileInput?.click();
  }

  private handlePackageFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.importOfflinePackage(String(reader.result ?? ''));
    reader.onerror = () => { this.mergeImportError = '读取离线包文件失败，请重新选择。'; };
    reader.readAsText(file);
    input.value = '';
  }

  private importOfflinePackage(text?: string): void {
    if (this.deviceMode === 'desktop' && this.project.status === 'frozen') {
      this.mergeImportError = '电脑工作稿处于冻结状态：已冻结版本保持原样，请先创建修订版后再导入合并。';
      return;
    }
    const raw = text ?? localStorage.getItem(OFFLINE_PACKAGE_KEY) ?? '';
    if (!raw) {
      this.mergeImportError = '还没有离线课程包：先在平板工作台导出，或选择一个 .json 离线包文件。';
      return;
    }
    const parsed = parseOfflinePackage(raw);
    if (!parsed.ok) {
      this.mergeImportError = parsed.error;
      return;
    }
    const session = startMergeSession(this.project, parsed.package, {
      failAfterProcessed: this.mergeFailAfter > 0 ? this.mergeFailAfter : undefined,
    });
    this.runAnalysis(session);
  }

  /** 逐模块分析并在每个检查点落盘，失败时保留中断现场 */
  private runAnalysis(session: MergeSession): void {
    try {
      const completed = processRemaining(session, {
        onCheckpoint: (checkpoint) => {
          this.mergeSession = checkpoint;
          saveMergeSession(checkpoint);
        },
      });
      this.mergeSession = completed;
      saveMergeSession(completed);
      const conflictCount = allConflicts(completed).length;
      this.showToast('success', conflictCount > 0
        ? `离线包已分析完成：${completed.processedModuleIds.length} 个模块已处理，发现 ${conflictCount} 处待选择差异。`
        : '离线包已分析完成：没有冲突，可直接应用合并。');
    } catch (error) {
      if (error instanceof MergeInterruptedError) {
        this.showToast('warning', error.message);
      } else {
        this.mergeSession = { ...session, lastError: '分析过程中出现异常，已保留已处理模块，可从中断处继续。' };
        saveMergeSession(this.mergeSession);
        this.showToast('danger', '导入处理异常，可从中断处恢复。');
      }
    }
  }

  private resumeMerge(): void {
    if (!this.mergeSession) return;
    this.mergeImportError = undefined;
    // 模拟中断阈值只触发一次；真实恢复时必须能跑完全部剩余模块
    this.runAnalysis({ ...this.mergeSession, failAfterProcessed: undefined, lastError: undefined });
  }

  private chooseResolution(conflictId: string, resolution: MergeSide | 'keep' | 'drop'): void {
    if (!this.mergeSession) return;
    this.mergeSession = resolveConflict(this.mergeSession, conflictId, resolution);
    saveMergeSession(this.mergeSession);
  }

  private applyMerge(): void {
    if (!this.mergeSession) return;
    try {
      const result = buildMergedProject(this.mergeSession);
      clearMergeSession();
      this.mergeSession = undefined;
      this.mergeModalOpen = false;
      this.past = [];
      this.future = [];
      this.project = result.project;
      this.persist();
      const noteCount = result.notes.length;
      this.showToast(
        'success',
        `合并已生效：${result.changeCount} 处自动合并、${result.conflictCount} 处冲突按选择写入工作稿。`
          + (noteCount ? `另有 ${noteCount} 条前置条件提醒，请检查。` : ''),
      );
      if (noteCount) {
        this.mergeApplyNotes = result.notes;
        this.activePanel = 'checks';
      }
    } catch (error) {
      this.showToast('danger', (error as Error).message);
    }
  }

  private abandonMerge(): void {
    clearMergeSession();
    this.mergeSession = undefined;
    this.mergeModalOpen = false;
    this.mergeImportError = undefined;
    this.showToast('medium', '已放弃本次离线合并，电脑工作稿保持原样。');
  }

  private selectModule(moduleId: string): void {
    const module = this.project.modules.find((item) => item.id === moduleId);
    this.project = { ...this.project, selectedModuleId: moduleId, selectedStepId: module?.steps[0]?.id ?? '' };
    this.persist();
  }

  private selectStep(stepId: string): void {
    this.project = { ...this.project, selectedStepId: stepId };
    this.persist();
  }

  private updateStep(patch: Partial<LessonStep>, toast?: string): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step),
      } : module),
    }), toast);
  }

  private updateCurrentModule(patch: Partial<CourseModule>): void {
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? { ...module, ...patch } : module),
    }));
  }

  private addModule(): void {
    const index = this.project.modules.length + 1;
    const module: CourseModule = {
      id: `module-${Date.now().toString(36)}`,
      title: `模块 ${index} · 未命名`,
      summary: '说明该模块的学习目标与适用场景。',
      color: ['#15827a', '#8a3ffc', '#b34331', '#376ea8'][index % 4],
      steps: [],
    };
    this.commit((draft) => ({ ...draft, modules: [...draft.modules, module], selectedModuleId: module.id, selectedStepId: '' }), '已创建课程模块。');
  }

  private addStep(kind: LessonStep['kind'] = '示范'): void {
    const module = this.currentModule;
    if (!module) return this.addModule();
    const prior = module.steps.at(-1);
    const step: LessonStep = {
      id: `step-${Date.now().toString(36)}`,
      title: `新${kind}步骤 ${module.steps.length + 1}`,
      kind,
      duration: 45,
      demoTitle: '等待上传或录制示范片段',
      demoUrl: '',
      handshape: '描述起始手形、掌心方向和运动路径。',
      gestureZone: '中央',
      caption: '填写送给学习者的字幕说明。',
      captionPosition: '下方安全区',
      camera: '正面',
      commonMistakes: [],
      exercise: kind === '练习' ? '填写练习任务。' : '',
      exerciseFeedback: kind === '练习' ? '填写反馈方式。' : '',
      altText: '',
      prerequisiteId: prior?.id ?? '',
      difficulty: '入门',
      cuePoints: [8, 20, 32],
    };
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((item) => item.id === module.id ? { ...item, steps: [...item.steps, step] } : item),
      selectedStepId: step.id,
    }), '已新增学习步骤。');
  }

  private duplicateStep(): void {
    const step = this.currentStep;
    if (!step) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((item) => item.id === step.id);
        const duplicate = { ...structuredClone(step), id: `step-${Date.now().toString(36)}`, title: `${step.title}（副本）` };
        return { ...module, steps: [...module.steps.slice(0, index + 1), duplicate, ...module.steps.slice(index + 1)] };
      }),
    }), '已复制当前步骤。');
  }

  private deleteStep(stepId: string): void {
    if (this.currentModule.steps.length <= 1) {
      this.showToast('warning', '模块至少保留一个学习步骤。');
      return;
    }
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.filter((step) => step.id !== stepId),
      } : module),
      selectedStepId: this.currentModule.steps.find((step) => step.id !== stepId)?.id ?? '',
    }), '已删除学习步骤。');
  }

  private moveStep(direction: number): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((step) => step.id === step.id);
        const nextIndex = Math.max(0, Math.min(module.steps.length - 1, index + direction));
        if (index === nextIndex) return module;
        const steps = [...module.steps];
        const [item] = steps.splice(index, 1);
        steps.splice(nextIndex, 0, item);
        return { ...module, steps };
      }),
    }), '已调整步骤顺序。');
  }

  private saveDraft(showMessage = true): void {
    if (this.pendingMerge) {
      this.showToast('warning', '离线合并未完成时不能覆盖工作稿，请先完成或放弃合并。');
      return;
    }
    if (this.project.status === 'frozen') {
      this.showToast('warning', '冻结版本不可覆盖，请先创建修订版。');
      return;
    }
    this.project = { ...this.project, status: 'draft', lastSavedAt: new Date().toISOString() };
    this.persist();
    if (showMessage) this.showToast('success', '草稿已保存在浏览器本地。');
  }

  private submitForReview(): void {
    if (this.pendingMerge) {
      this.activePanel = 'editor';
      this.openMergeModal();
      this.showToast('danger', `还有 ${this.pendingConflictCount} 处合并冲突待选择，全部处理完才能提交复核。`);
      return;
    }
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `仍有 ${blocking.length} 个阻断问题，修复后才能提交复核。`);
      return;
    }
    this.commit((draft) => ({ ...draft, status: 'review' }), '课程已提交复核。');
  }

  private returnForChanges(): void {
    this.commit((draft) => ({ ...draft, status: 'changes' }), '课程已退回修改。');
  }

  private freezeVersion(): void {
    if (this.pendingMerge) {
      this.openMergeModal();
      this.showToast('danger', '离线合并冲突未全部处理完，不能冻结版本。');
      return;
    }
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `冻结前仍有 ${blocking.length} 个阻断问题。`);
      return;
    }
    this.commit((draft) => {
      const { frozenVersions, ...snapshot } = cloneProject(draft);
      const version = {
        id: `frozen-${Date.now().toString(36)}`,
        label: `冻结版本 v${frozenVersions.length + 1}`,
        createdAt: new Date().toISOString(),
        snapshot,
      };
      return { ...draft, status: 'frozen', frozenVersions: [version, ...frozenVersions] };
    }, '当前课程版本已冻结。');
    this.playing = false;
  }

  private reviseFrozen(): void {
    this.commit((draft) => ({ ...draft, status: 'draft' }), '已创建修订版，可继续编辑。');
  }

  private togglePlay(): void {
    if (this.playTimer) {
      window.clearInterval(this.playTimer);
      this.playTimer = undefined;
      this.playing = false;
      return;
    }
    const duration = Math.max(10, this.currentStep?.duration ?? 40);
    this.playing = true;
    this.playTimer = window.setInterval(() => {
      this.playProgress += 0.25 / duration;
      if (this.playProgress >= 1) {
        this.playProgress = 0;
        this.playing = false;
        if (this.playTimer) window.clearInterval(this.playTimer);
        this.playTimer = undefined;
      }
    }, 250);
  }

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  private renderStatusBadge() {
    if (this.project.status === 'review') return <ion-badge color="warning">待复核</ion-badge>;
    if (this.project.status === 'changes') return <ion-badge color="danger">已退回</ion-badge>;
    if (this.project.status === 'frozen') return <ion-badge color="success">已冻结</ion-badge>;
    return <ion-badge color="medium">草稿</ion-badge>;
  }

  private renderStepListItem(step: LessonStep, index: number) {
    const active = step.id === this.currentStep?.id;
    const issueCount = this.checks.filter((check) => check.stepId === step.id && check.severity !== 'info').length;
    return (
      <button class={`step-list-item ${active ? 'active' : ''}`} onClick={() => this.selectStep(step.id)}>
        <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
        <span class="step-copy">
          <strong>{step.title}</strong>
          <small>{step.kind} · {step.duration}s · {step.difficulty}</small>
        </span>
        {issueCount > 0 && <span class="step-issue-count">{issueCount}</span>}
      </button>
    );
  }

  private renderStepEditor() {
    const step = this.currentStep;
    if (!step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">手</div>
          <h2>这个模块还没有学习步骤</h2>
          <p>添加示范、讲解或练习步骤，然后设置前置条件与难度。</p>
          <ion-button class="studio-button" onClick={() => this.addStep('示范')}>添加第一个步骤</ion-button>
        </div>
      );
    }
    const frozen = this.project.status === 'frozen';
    const module = this.currentModule;
    const prerequisites = module.steps.filter((candidate, index) => candidate.id !== step.id && index < module.steps.findIndex((item) => item.id === step.id));
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 {module.steps.findIndex((item) => item.id === step.id) + 1}</span>
            <h1>{step.title}</h1>
            <p>最后修改 {this.formatDate(this.project.lastSavedAt)} · 修订号 {this.project.revision}</p>
          </div>
          <div class="title-actions">
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(-1)} title="Alt + ↑">上移</ion-button>
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(1)} title="Alt + ↓">下移</ion-button>
            <ion-button fill="outline" class="studio-button" onClick={() => this.duplicateStep()}>复制</ion-button>
            <ion-button fill="outline" color="danger" class="studio-button" onClick={() => this.deleteStep(step.id)}>删除</ion-button>
          </div>
        </div>

        {frozen && (
          <div class="frozen-callout">
            <div><strong>此版本已冻结</strong><span>字段已锁定，仍可预览和运行检查。</span></div>
            <ion-button size="small" class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
          </div>
        )}

        <section class="form-card">
          <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
          <div class="form-grid two">
            <ion-input disabled={frozen} label="步骤标题" labelPlacement="stacked" class="studio-input" value={step.title} onIonInput={(event) => this.updateStep({ title: event.detail.value ?? '' })} />
            <ion-select disabled={frozen} label="步骤类型" labelPlacement="stacked" class="studio-input" value={step.kind} onIonChange={(event) => this.updateStep({ kind: event.detail.value as LessonStep['kind'] })}>
              <ion-select-option value="示范">示范</ion-select-option>
              <ion-select-option value="讲解">讲解</ion-select-option>
              <ion-select-option value="练习">练习</ion-select-option>
            </ion-select>
            <ion-select disabled={frozen} label="难度标签" labelPlacement="stacked" class="studio-input" value={step.difficulty} onIonChange={(event) => this.updateStep({ difficulty: event.detail.value as Difficulty })}>
              {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} type="number" min="10" max="600" label="预计时长（秒）" labelPlacement="stacked" class="studio-input" value={String(step.duration)} onIonInput={(event) => this.updateStep({ duration: Number(event.detail.value) || 0 })} />
          </div>
        </section>

        <section class="form-card">
          <div class="section-title"><span>02</span><div><h2>示范片段与镜头</h2><p>记录素材标识、手形、镜头角度和动作区域</p></div></div>
          <div class="demo-row">
            <div class={`video-thumbnail zone-${step.gestureZone}`}>
              <span class="play-mark">▶</span>
              <strong>{step.kind}片段</strong>
              <small>{step.camera}</small>
            </div>
            <div class="demo-fields">
              <ion-input disabled={frozen} label="示范片段名称" labelPlacement="stacked" class="studio-input" value={step.demoTitle} onIonInput={(event) => this.updateStep({ demoTitle: event.detail.value ?? '' })} />
              <ion-input disabled={frozen} label="本地素材地址（可空）" labelPlacement="stacked" class="studio-input" value={step.demoUrl} placeholder="例如 assets/hello.mp4" onIonInput={(event) => this.updateStep({ demoUrl: event.detail.value ?? '' })} />
            </div>
          </div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="镜头角度" labelPlacement="stacked" class="studio-input" value={step.camera} onIonChange={(event) => this.updateStep({ camera: event.detail.value as CameraAngle })}>
              {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-select disabled={frozen} label="主要手形区域" labelPlacement="stacked" class="studio-input" value={step.gestureZone} onIonChange={(event) => this.updateStep({ gestureZone: event.detail.value as GestureZone })}>
              {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
          </div>
          <ion-textarea disabled={frozen} autoGrow label="手形说明" labelPlacement="stacked" class="studio-input" value={step.handshape} onIonInput={(event) => this.updateStep({ handshape: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>检查字幕位置、动作遮挡与替代文本</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="字幕位置" labelPlacement="stacked" class="studio-input" value={step.captionPosition} onIonChange={(event) => this.updateStep({ captionPosition: event.detail.value as CaptionPosition })}>
              {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="替代文本状态" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText ? '已填写' : '缺失'} readonly />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="步骤字幕" labelPlacement="stacked" class="studio-input" value={step.caption} onIonInput={(event) => this.updateStep({ caption: event.detail.value ?? '' })} />
          <ion-textarea disabled={frozen} autoGrow label="替代文本（必须描述动作与表情）" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText} onIonInput={(event) => this.updateStep({ altText: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>前置步骤、常见错误、练习任务与反馈</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="前置条件" labelPlacement="stacked" class="studio-input" value={step.prerequisiteId} onIonChange={(event) => this.updateStep({ prerequisiteId: event.detail.value ?? '' })}>
              <ion-select-option value="">无前置条件</ion-select-option>
              {prerequisites.map((item) => <ion-select-option value={item.id}>{item.title}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="检查点（秒，用逗号分隔）" labelPlacement="stacked" class="studio-input" value={step.cuePoints.join(', ')} onIonInput={(event) => this.updateStep({ cuePoints: (event.detail.value ?? '').split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value)) })} />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="常见错误（每行一条）" labelPlacement="stacked" class="studio-input" value={step.commonMistakes.join('\n')} onIonInput={(event) => this.updateStep({ commonMistakes: (event.detail.value ?? '').split('\n').filter(Boolean) })} />
          <div class="form-grid two">
            <ion-textarea disabled={frozen} autoGrow label="练习任务" labelPlacement="stacked" class="studio-input" value={step.exercise} onIonInput={(event) => this.updateStep({ exercise: event.detail.value ?? '' })} />
            <ion-textarea disabled={frozen} autoGrow label="练习反馈" labelPlacement="stacked" class="studio-input" value={step.exerciseFeedback} onIonInput={(event) => this.updateStep({ exerciseFeedback: event.detail.value ?? '' })} />
          </div>
        </section>
      </div>
    );
  }

  private renderPreview() {
    const step = this.currentStep;
    const progress = Math.round(this.playProgress * 100);
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">学习者预览</span><h2>设备与安全区检查</h2></div>
          <ion-segment value={this.previewSize} class="studio-segment" onIonChange={(event) => { this.previewSize = event.detail.value as PreviewSize; }}>
            <ion-segment-button value="phone">手机</ion-segment-button>
            <ion-segment-button value="tablet">平板</ion-segment-button>
          </ion-segment>
        </div>
        {step ? (
          <div class={`device-frame ${this.previewSize}`}>
            <div class="device-top"><span>{this.previewSize === 'phone' ? '9:16' : '4:3'}</span><span>{step.camera}</span></div>
            <div class={`preview-stage zone-${step.gestureZone} caption-${step.captionPosition.replace(/\s|%/g, '')} ${step.captionPosition === '画面中央' && step.gestureZone === '中央' ? 'overlap-warning' : ''}`}>
              <div class="stage-grid" />
              <div class="signer">
                <div class="head"><span class="face"><i /><i /></span></div>
                <div class="torso" />
                <div class="arm arm-left"><span class="hand" /></div>
                <div class="arm arm-right"><span class="hand" /></div>
              </div>
              <div class="gesture-marker" style={{ left: step.gestureZone === '左侧' ? '18%' : step.gestureZone === '右侧' ? '70%' : '43%' }} />
              <div class="caption-preview">{step.caption || '未填写字幕'}</div>
              {step.captionPosition === '角标提示' && <div class="corner-caption">{step.caption.slice(0, 18) || '角标提示'}</div>}
              <div class="safe-area"><span>字幕安全区</span></div>
            </div>
            <div class="player-controls">
              <button class="play-button" onClick={() => this.togglePlay()}>{this.playing ? 'Ⅱ' : '▶'}</button>
              <div class="player-timeline">
                <span style={{ width: `${progress}%` }} />
                {step.cuePoints.map((cue) => <i style={{ left: `${Math.min(100, (cue / Math.max(1, step.duration)) * 100)}%` }} title={`检查点 ${cue}s`} />)}
              </div>
              <span class="time-code">{String(Math.floor(this.playProgress * step.duration)).padStart(2, '0')} / {step.duration}s</span>
            </div>
            <div class="preview-meta">
              <div><strong>{step.kind}</strong><span>步骤类型</span></div>
              <div><strong>{step.difficulty}</strong><span>难度标签</span></div>
              <div><strong>{step.cuePoints.length}</strong><span>检查点</span></div>
            </div>
            <p class="preview-caption-text">{step.caption}</p>
          </div>
        ) : <div class="empty-preview">选择步骤后显示设备预览。</div>}
      </section>
    );
  }

  private renderChecks() {
    const errors = this.checks.filter((check) => check.severity === 'error');
    const warnings = this.checks.filter((check) => check.severity === 'warning');
    const info = this.checks.filter((check) => check.severity === 'info');
    return (
      <section class="checks-panel">
        <div class="checks-summary">
          <div class="check-stat danger"><strong>{errors.length}</strong><span>阻断问题</span></div>
          <div class="check-stat warning"><strong>{warnings.length}</strong><span>需注意</span></div>
          <div class="check-stat"><strong>{info.length}</strong><span>优化建议</span></div>
        </div>
        <div class="check-list">
          {this.mergeApplyNotes.length > 0 && this.mergeApplyNotes.map((note) => (
            <div class="check-item warning">
              <span class="check-severity">△</span>
              <span><strong>合并后的前置条件提醒</strong><small>{note}</small></span>
            </div>
          ))}
          {this.checks.length === 0 && this.mergeApplyNotes.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级和替代文本检查均已通过。</p></div>}
          {this.checks.map((check) => (
            <button class={`check-item ${check.severity}`} onClick={() => {
              if (check.moduleId) this.selectModule(check.moduleId);
              if (check.stepId) this.selectStep(check.stepId);
              this.activePanel = 'editor';
            }}>
              <span class="check-severity">{check.severity === 'error' ? '!' : check.severity === 'warning' ? '△' : 'i'}</span>
              <span><strong>{check.title}</strong><small>{check.detail}</small></span>
              <span class="check-arrow">→</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  /* ---------------------------------------------------------------- */
  /* 离线合并弹层                                                       */
  /* ---------------------------------------------------------------- */

  private prerequisiteTitleLookup(): (id: string) => string | undefined {
    const session = this.mergeSession;
    if (!session) return () => undefined;
    const titles = new Map<string, string>();
    for (const project of [session.base, session.local, session.incoming]) {
      for (const module of project.modules) {
        for (const step of module.steps) titles.set(step.id, step.title);
      }
    }
    return (id: string) => titles.get(id);
  }

  private renderValueCell(field: string, value: unknown): string {
    return formatFieldValue(field, value, this.prerequisiteTitleLookup());
  }

  private renderConflictSideCard(side: MergeSide, title: string, valueText: string, active: boolean, onClick: () => void) {
    return (
      <button class={`merge-choice side-${side} ${active ? 'selected' : ''}`} onClick={onClick}>
        <span class="merge-choice-head"><i class="choice-radio" /><strong>{title}</strong></span>
        <span class="merge-choice-value">{valueText}</span>
      </button>
    );
  }

  private renderFieldConflict(conflict: Extract<MergeConflict, { kind: 'field' }>) {
    return (
      <article class={`conflict-card ${conflict.resolved ? 'resolved' : ''}`}>
        <header>
          <div><span class="conflict-kind">同一位置两边都改</span><strong>{conflict.location} · {conflict.fieldLabel}</strong></div>
          <span class="conflict-state">{conflict.resolved ? '已选择' : '待选择'}</span>
        </header>
        <div class="merge-diff-grid">
          <div class="merge-value base">
            <span>共同原稿（导出时）</span>
            <p>{this.renderValueCell(conflict.field, conflict.baseValue)}</p>
          </div>
          <div class="merge-choices">
            {this.renderConflictSideCard('local', LOCAL_SIDE_LABEL, this.renderValueCell(conflict.field, conflict.localValue), conflict.resolution === 'local', () => this.chooseResolution(conflict.id, 'local'))}
            {this.renderConflictSideCard('incoming', INCOMING_SIDE_LABEL, this.renderValueCell(conflict.field, conflict.incomingValue), conflict.resolution === 'incoming', () => this.chooseResolution(conflict.id, 'incoming'))}
          </div>
        </div>
      </article>
    );
  }

  private renderDeleteModifyConflict(conflict: Extract<MergeConflict, { kind: 'delete-modify' }>) {
    const deletingLabel = conflict.deletingSide === 'local' ? LOCAL_SIDE_LABEL : INCOMING_SIDE_LABEL;
    const keepingLabel = conflict.keepingSide === 'local' ? LOCAL_SIDE_LABEL : INCOMING_SIDE_LABEL;
    return (
      <article class={`conflict-card ${conflict.resolved ? 'resolved' : ''}`}>
        <header>
          <div><span class="conflict-kind">删除 / 修改冲突</span><strong>{conflict.location}</strong></div>
          <span class="conflict-state">{conflict.resolved ? '已选择' : '待选择'}</span>
        </header>
        <p class="conflict-desc">{deletingLabel}删除了这一项，但{keepingLabel}对它做了修改。选择保留修改或执行删除后才会生效。</p>
        <div class="merge-choices horizontal">
          <button class={`merge-choice side-${conflict.keepingSide} ${conflict.resolution === 'keep' ? 'selected' : ''}`} onClick={() => this.chooseResolution(conflict.id, 'keep')}>
            <span class="merge-choice-head"><i class="choice-radio" /><strong>保留{keepingLabel}的修改</strong></span>
          </button>
          <button class={`merge-choice delete ${conflict.resolution === 'drop' ? 'selected' : ''}`} onClick={() => this.chooseResolution(conflict.id, 'drop')}>
            <span class="merge-choice-head"><i class="choice-radio" /><strong>执行{deletingLabel}的删除</strong></span>
          </button>
        </div>
      </article>
    );
  }

  private renderOrderList(entries: { id: string; title: string }[], active: boolean) {
    return (
      <ol class={`merge-order-list ${active ? 'selected' : ''}`}>
        {entries.map((entry, index) => (
          <li key={entry.id}><span>{String(index + 1).padStart(2, '0')}</span>{entry.title}</li>
        ))}
      </ol>
    );
  }

  private renderOrderConflict(conflict: Extract<MergeConflict, { kind: 'order' }>) {
    return (
      <article class={`conflict-card ${conflict.resolved ? 'resolved' : ''}`}>
        <header>
          <div><span class="conflict-kind">顺序冲突</span><strong>{conflict.location}</strong></div>
          <span class="conflict-state">{conflict.resolved ? '已选择' : '待选择'}</span>
        </header>
        <p class="conflict-desc">两边都调整了顺序且结果不同。前置条件会随对应步骤迁移，无需重新指定。</p>
        <div class="merge-order-layout">
          <div class="merge-order-col"><span>共同原稿顺序</span>{this.renderOrderList(conflict.baseOrder, false)}</div>
          <div class="merge-order-col">
            <span>选择一边的顺序</span>
            <button class={`merge-order-pick ${conflict.resolution === 'local' ? 'selected' : ''}`} onClick={() => this.chooseResolution(conflict.id, 'local')}>
              <em>{LOCAL_SIDE_LABEL}</em>{this.renderOrderList(conflict.localOrder, conflict.resolution === 'local')}
            </button>
            <button class={`merge-order-pick ${conflict.resolution === 'incoming' ? 'selected' : ''}`} onClick={() => this.chooseResolution(conflict.id, 'incoming')}>
              <em>{INCOMING_SIDE_LABEL}</em>{this.renderOrderList(conflict.incomingOrder, conflict.resolution === 'incoming')}
            </button>
          </div>
        </div>
      </article>
    );
  }

  private renderConflict(conflict: MergeConflict) {
    if (conflict.kind === 'field') return this.renderFieldConflict(conflict);
    if (conflict.kind === 'delete-modify') return this.renderDeleteModifyConflict(conflict);
    return this.renderOrderConflict(conflict);
  }

  private renderMergeModal() {
    if (!this.mergeModalOpen) return null;
    const session = this.mergeSession;
    const totalModules = session?.moduleQueue.length ?? 0;
    const processed = session?.processedModuleIds.length ?? 0;
    const progressPct = totalModules === 0 ? 100 : Math.round((processed / totalModules) * 100);
    const conflicts = session ? allConflicts(session) : [];
    const unresolved = session ? unresolvedConflicts(session).length : 0;
    const interrupted = Boolean(session && !session.analysisComplete);
    const changes = session?.changes ?? [];

    return (
      <div class="merge-overlay" onClick={(event) => { if (event.target === event.currentTarget) this.closeMergeModal(); }}>
        <div class="merge-dialog">
          <header class="merge-dialog-head">
            <div>
              <span class="eyebrow">离线课程包合并</span>
              <h2>并入平板离线改动</h2>
            </div>
            <button class="merge-close" onClick={() => this.closeMergeModal()}>×</button>
          </header>

          <div class="merge-dialog-body">
            {!session && (
              <div class="merge-intake">
                <p>系统按模块和步骤编号识别两边改动：不同位置直接合并；同一位置两边都改过时，先保留两份并标出差异，逐处选择后才生效。已冻结版本保持原样。</p>
                <div class="merge-intake-actions">
                  <ion-button class="studio-button" onClick={() => this.triggerPackageFile()}>选择离线包文件（.json）</ion-button>
                  <ion-button fill="outline" class="studio-button" onClick={() => this.importOfflinePackage()}>导入本机最近导出的离线包</ion-button>
                  <input type="file" accept="application/json,.json" hidden ref={(el) => { this.fileInput = el as HTMLInputElement; }} onChange={(event) => this.handlePackageFile(event)} />
                </div>
                <label class="merge-fail-option">
                  模拟导入中断（处理完前 N 个模块后中断，0 表示不中断）
                  <input type="number" min="0" max="20" value={String(this.mergeFailAfter)} onInput={(event) => { this.mergeFailAfter = Number((event.target as HTMLInputElement).value) || 0; }} />
                </label>
                {this.mergeImportError && <div class="merge-error">{this.mergeImportError}</div>}
              </div>
            )}

            {session && (
              <div class="merge-progress">
                <div class="merge-progress-row">
                  <strong>模块分析 {processed} / {totalModules}</strong>
                  <span>{session.analysisComplete ? '分析已完成' : '可随时关闭，进度已保存'}</span>
                </div>
                <div class="merge-progress-track"><i style={{ width: `${progressPct}%` }} /></div>
                {session.lastError && <div class="merge-warning">⚠ {session.lastError}<ion-button size="small" class="studio-button" onClick={() => this.resumeMerge()}>从中断处继续</ion-button></div>}
                <div class="merge-meta">
                  <span>离线包导出：{this.formatDate(session.packageExportedAt)}</span>
                  <span>基于修订号 {session.baseRevision}</span>
                  <span class={unresolved ? 'pending' : ''}>待选择差异 {unresolved} / {conflicts.length}</span>
                  <span>自动合并 {changes.length} 处</span>
                </div>
              </div>
            )}

            {session && conflicts.length > 0 && (
              <section class="merge-section">
                <h3>待处理差异（先保留两份，逐处选择）</h3>
                <div class="conflict-list">{conflicts.map((conflict) => this.renderConflict(conflict))}</div>
              </section>
            )}

            {session && session.analysisComplete && conflicts.length === 0 && (
              <div class="merge-all-clear"><strong>✓ 两边没有同位置冲突</strong><p>所有改动已按模块和步骤编号自动合并，应用后写入电脑工作稿。</p></div>
            )}

            {session && changes.length > 0 && (
              <section class="merge-section">
                <h3>已自动合并的改动</h3>
                <div class="merge-change-list">
                  {changes.slice().reverse().map((change) => (
                    <div class={`merge-change source-${change.source}`} key={change.id}>
                      <span class="merge-change-source">{change.source === 'local' ? LOCAL_SIDE_LABEL : change.source === 'incoming' ? INCOMING_SIDE_LABEL : change.source === 'system' ? '迁移' : '两边一致'}</span>
                      <p>{change.message}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          {session && (
            <footer class="merge-dialog-foot">
              <ion-button fill="clear" color="medium" class="studio-button" onClick={() => this.abandonMerge()}>放弃合并</ion-button>
              <div class="merge-foot-right">
                {interrupted && <span class="merge-foot-hint">分析未完成，已处理模块和待选冲突会继续保留。</span>}
                {!interrupted && unresolved > 0 && <span class="merge-foot-hint danger">还有 {unresolved} 处差异未选择，选完才能应用并提交复核。</span>}
                <ion-button color="primary" class="studio-button" disabled={!session.analysisComplete || unresolved > 0} onClick={() => this.applyMerge()}>应用合并到工作稿</ion-button>
              </div>
            </footer>
          )}
        </div>
      </div>
    );
  }

  private renderPendingMergeBanner() {
    if (!this.pendingMerge || !this.mergeSession) return null;
    const unresolved = unresolvedConflicts(this.mergeSession).length;
    const complete = this.mergeSession.analysisComplete;
    return (
      <div class="merge-banner">
        <div>
          <strong>{complete ? '离线包已导入，等待差异选择' : '离线包导入曾中断，可从检查点恢复'}</strong>
          <span>
            已处理模块 {this.mergeSession.processedModuleIds.length}/{this.mergeSession.moduleQueue.length}
            · 待选择差异 {unresolved} 处
            {unresolved > 0 ? '，冲突处理完之前不能提交复核。' : '。'}
          </span>
        </div>
        <div class="merge-banner-actions">
          {!complete && <ion-button fill="outline" size="small" class="studio-button" onClick={() => this.resumeMerge()}>从中断处继续</ion-button>}
          <ion-button size="small" class="studio-button" onClick={() => this.openMergeModal()}>{complete ? '处理差异' : '查看合并'}</ion-button>
          <ion-button fill="clear" size="small" color="medium" class="studio-button" onClick={() => this.abandonMerge()}>放弃</ion-button>
        </div>
      </div>
    );
  }

  render() {
    const module = this.currentModule;
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    const isTablet = this.deviceMode === 'tablet';
    return (
      <Host>
        <ion-app>
          <ion-header class="studio-header">
            <ion-toolbar>
              <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>{isTablet ? '平板离线工作台' : '教研室电脑工作稿'}</span></div></ion-buttons>
              <ion-buttons slot="end" class="header-actions">
                <ion-segment value={this.deviceMode} class="device-segment" onIonChange={(event) => this.switchDeviceMode(event.detail.value as DeviceMode)}>
                  <ion-segment-button value="desktop">电脑</ion-segment-button>
                  <ion-segment-button value="tablet">平板</ion-segment-button>
                </ion-segment>
                <button class={`connection-status ${this.offline ? 'offline' : ''}`} onClick={() => { this.offline = !this.offline; this.showToast(this.offline ? 'warning' : 'success', this.offline ? '已进入离线模拟，编辑继续保存在本机。' : '已恢复在线模拟，本地草稿保持同步。'); }}><span />{this.offline ? '离线编辑中（点击恢复）' : '本地自动保存（点击模拟离线）'}</button>
                <ion-button fill="clear" class="studio-button" disabled={this.past.length === 0} onClick={() => this.undo()}>撤销</ion-button>
                <ion-button fill="clear" class="studio-button" disabled={this.future.length === 0} onClick={() => this.redo()}>重做</ion-button>
                <ion-button fill="outline" class="studio-button" onClick={() => this.exportOfflinePackage()}>
                  {isTablet ? '导出离线包带回' : '导出课程到平板'}
                </ion-button>
                {isTablet
                  ? <ion-button fill="outline" class="studio-button" onClick={() => this.saveDraft()}>保存草稿</ion-button>
                  : <ion-button fill="outline" class="studio-button" onClick={() => this.openMergeModal()}>
                      导入合并{this.pendingConflictCount > 0 ? `（${this.pendingConflictCount} 待选）` : ''}
                    </ion-button>}
                {!isTablet && (this.project.status === 'review'
                  ? <ion-button color="success" class="studio-button" onClick={() => this.freezeVersion()}>冻结版本</ion-button>
                  : this.project.status === 'changes'
                    ? <ion-button color="warning" class="studio-button" disabled={this.pendingMerge} onClick={() => this.submitForReview()}>重新提交</ion-button>
                    : this.project.status === 'frozen'
                      ? <ion-button class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
                      : <ion-button color="primary" class="studio-button" disabled={this.pendingMerge} onClick={() => this.submitForReview()}>提交复核</ion-button>)}
              </ion-buttons>
            </ion-toolbar>
          </ion-header>

          <ion-content fullscreen>
            {this.renderPendingMergeBanner()}
            {isTablet && (
              <div class="device-mode-banner tablet">
                <strong>平板离线模式</strong>
                <span>数据保存在平板本地；改完字幕、步骤顺序或前置条件后，点右上角「导出离线包带回」，再到电脑模式导入合并。</span>
              </div>
            )}
            <div class="project-ribbon">
              <div class="project-heading">
                {this.renderStatusBadge()}
                <ion-input value={this.project.title} class="project-title-input" onIonInput={(event) => { if (!this.pendingMerge) { this.project = { ...this.project, title: event.detail.value ?? '' }; this.persist(); } }} />
                <span>{this.project.teacher} · {this.project.audience}</span>
              </div>
              <div class="project-metrics">
                <div><strong>{this.project.modules.length}</strong><span>模块</span></div>
                <div><strong>{this.project.modules.reduce((sum, item) => sum + item.steps.length, 0)}</strong><span>步骤</span></div>
                <div><strong>{Math.ceil(this.project.modules.reduce((sum, item) => sum + item.steps.reduce((total, lesson) => total + lesson.duration, 0), 0) / 60)}</strong><span>分钟</span></div>
                <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
              </div>
              <div class="workflow-actions">
                {this.project.status === 'review' && <ion-button fill="clear" color="danger" class="studio-button" onClick={() => this.returnForChanges()}>退回修改</ion-button>}
                {this.project.status === 'draft' && <ion-button fill="clear" class="studio-button" onClick={() => this.addModule()}>＋ 新建模块</ion-button>}
                <ion-button fill="clear" class="studio-button" onClick={() => this.addStep('练习')}>＋ 练习步骤</ion-button>
              </div>
            </div>

            <main class="studio-workspace">
              <aside class="course-panel">
                <div class="panel-heading"><div><span class="eyebrow">课程结构</span><h2>模块与步骤</h2></div><button class="add-step-button" onClick={() => this.addStep('示范')}>＋</button></div>
                <div class="module-list">
                  {this.project.modules.map((item) => (
                    <section class={`module-card ${item.id === module?.id ? 'active' : ''}`} key={item.id}>
                      <button class="module-head" onClick={() => this.selectModule(item.id)}>
                        <span class="module-color" style={{ background: item.color }} />
                        <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤</small></span>
                      </button>
                      {item.id === module?.id && <div class="step-list">{item.steps.map((lesson, index) => this.renderStepListItem(lesson, index))}</div>}
                    </section>
                  ))}
                </div>
                <div class="module-editor">
                  <ion-input disabled={this.project.status === 'frozen'} label="当前模块标题" labelPlacement="stacked" class="studio-input" value={module?.title ?? ''} onIonInput={(event) => this.updateCurrentModule({ title: event.detail.value ?? '' })} />
                  <ion-textarea disabled={this.project.status === 'frozen'} autoGrow label="模块目标" labelPlacement="stacked" class="studio-input" value={module?.summary ?? ''} onIonInput={(event) => this.updateCurrentModule({ summary: event.detail.value ?? '' })} />
                </div>
              </aside>

              <section class="editor-panel">
                <div class="panel-switcher">
                  <button class={this.activePanel === 'editor' ? 'active' : ''} onClick={() => { this.activePanel = 'editor'; }}>步骤编排</button>
                  <button class={this.activePanel === 'checks' ? 'active' : ''} onClick={() => { this.activePanel = 'checks'; }}>发布前检查 <span>{this.checks.length}</span></button>
                </div>
                <div class="editor-scroll">{this.activePanel === 'editor' ? this.renderStepEditor() : this.renderChecks()}</div>
              </section>

              {this.renderPreview()}
            </main>
          </ion-content>
          {this.renderMergeModal()}
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3200} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}
