import * as vscode from 'vscode';
import { DependencyScanner, ModuleInfo } from './dependencyScanner';

export class ModuleTreeProvider implements vscode.TreeDataProvider<ModuleTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ModuleTreeNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private scanner: DependencyScanner;
    private modules: Map<string, ModuleInfo> = new Map();
    private cycles: string[][] = [];
    private viewType: string;
    private context: vscode.ExtensionContext;

    constructor(scanner: DependencyScanner, viewType: string, context: vscode.ExtensionContext) {
        this.scanner = scanner;
        this.viewType = viewType;
        this.context = context;
        this.scanner.onDidUpdate(() => {
            this.modules = this.scanner.getModules();
            this.cycles = this.scanner.getCycles();
            this.ensureDefaultTop(); // 每次扫描后确保有默认 top
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    // 获取当前视图的顶级模块列表
    private getTopModules(): string[] {
        const allModules = Array.from(this.modules.keys());
        const calledModules = new Set<string>();
        for (const mod of this.modules.values()) {
            for (const inst of mod.instances) {
                calledModules.add(inst.moduleName);
            }
        }
        return allModules.filter(mod => !calledModules.has(mod));
    }

    // 确保有默认的 top 模块
    private ensureDefaultTop() {
        const topKey = `${this.viewType}TopModule`;
        let currentTop = this.context.workspaceState.get<string>(topKey, '');
        const topModules = this.getTopModules();
        if (topModules.length === 0) return;
        if (!currentTop || !topModules.includes(currentTop)) {
            const defaultTop = topModules.sort()[0];
            this.context.workspaceState.update(topKey, defaultTop);
            this.refresh();
        }
    }

    // 判断某模块是否为顶级模块
    public isTopLevel(moduleName: string): boolean {
        const topModules = this.getTopModules();
        return topModules.includes(moduleName);
    }

    getTreeItem(element: ModuleTreeNode): vscode.TreeItem {
        const topModule = this.context.workspaceState.get<string>(`${this.viewType}TopModule`, '');
        if (element.info && element.info.name === topModule) {
            element.iconPath = new vscode.ThemeIcon('star-full');
        }
        return element;
    }

    async getChildren(element?: ModuleTreeNode): Promise<ModuleTreeNode[]> {
        if (!element) {
            const nodes: ModuleTreeNode[] = [];
            const topModules = this.getTopModules();
            const topModule = this.context.workspaceState.get<string>(`${this.viewType}TopModule`, '');
            // 排序：top 模块在最前，其余按字母序
            topModules.sort((a, b) => {
                if (a === topModule) return -1;
                if (b === topModule) return 1;
                return a.localeCompare(b);
            });
            for (const mod of topModules) {
                const modInfo = this.modules.get(mod);
                // 判断是否有子节点（非 import 的实例化）
                const hasChildren = modInfo && modInfo.instances.length > 0;
                const collapsibleState = hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
                const node = new ModuleTreeNode(
                    mod,
                    collapsibleState,
                    modInfo ?? null,
                    this.isModuleInCycle(mod),
                    modInfo?.kind == 'module' ? 'moduleNode:top' : 'moduleNode:normal'
                );
                nodes.push(node);
            }
            return nodes;
        } else {
            const moduleInfo = element.info;
            if (!moduleInfo) return [];
            const children: ModuleTreeNode[] = [];
            for (const inst of moduleInfo.instances) {
                const childInfo = this.modules.get(inst.moduleName);
                const isImport = inst.instanceName === 'import';
                const label = isImport
                    ? `${inst.moduleName} (import)`
                    : (inst.instanceName ? `${inst.instanceName} (${inst.moduleName})` : inst.moduleName);
                
                // 判断子节点是否有进一步子节点
                let hasGrandChildren = false;
                if (childInfo) {
                    // 排除 import 类型的实例化
                    hasGrandChildren = childInfo.instances.length > 0;
                }
                const collapsible = hasGrandChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
                
                const node = new ModuleTreeNode(
                    label,
                    collapsible,
                    childInfo ?? null,
                    this.isModuleInCycle(inst.moduleName)
                );
                if (isImport && childInfo && childInfo.kind !== 'undefined') {
                    node.iconPath = new vscode.ThemeIcon('library');
                    node.tooltip = `Imported package: ${inst.moduleName}`;
                } else if (childInfo && childInfo.kind === 'undefined') {
                    node.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                    node.tooltip = `Module ${inst.moduleName} is referenced but no definition found.`;
                }
                children.push(node);
            }
            // 排序：import 优先，其次 interface，最后 module
            children.sort((a, b) => {
                const aIsImport = a.label.endsWith('(import)');
                const bIsImport = b.label.endsWith('(import)');
                if (aIsImport && !bIsImport) return -1;
                if (!aIsImport && bIsImport) return 1;
                const aKind = a.info?.kind || '';
                const bKind = b.info?.kind || '';
                const order: { [key: string]: number } = {
                    'interface': 0,
                    'module': 1,
                    'undefined': 2
                };
                const aOrder = order[aKind] ?? 3;
                const bOrder = order[bKind] ?? 3;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.label.localeCompare(b.label);
            });
            return children;
        }
    }

    private isModuleInCycle(moduleName: string): boolean {
        return this.cycles.some(cycle => cycle.includes(moduleName));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }
}

export class ModuleTreeNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly info: ModuleInfo | null,
        public readonly hasCycle: boolean = false,
        public readonly contextValue?: string
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
        this.tooltip = info ? `File: ${info.file}\nType: ${info.kind}` : `Module ${label} (no definition found)`;

        if (hasCycle) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        } else if (info) {
            switch (info.kind) {
                case 'module':
                    this.iconPath = new vscode.ThemeIcon('symbol-module');
                    break;
                case 'package':
                    this.iconPath = new vscode.ThemeIcon('package');
                    break;
                case 'interface':
                    this.iconPath = new vscode.ThemeIcon('symbol-interface');
                    break;
                case 'import':
                    this.iconPath = new vscode.ThemeIcon('library');
                    break;
                case 'undefined':
                    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                    break;
                default:
                    this.iconPath = new vscode.ThemeIcon('symbol-structure');
            }
        } else {
            this.iconPath = new vscode.ThemeIcon('question');
        }

        if (info && info.file && info.range) {
            const position = new vscode.Position(info.range.line, info.range.character);
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
                    vscode.Uri.file(info.file),
                    { selection: new vscode.Range(position, position) }
                ]
            };
        } else if (info && info.file) {
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(info.file)]
            };
        }
    }
}
