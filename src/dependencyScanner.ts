import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
const readFile = promisify(fs.readFile);

let parserInstance: any = null;

async function initParser() {
    try {
        const treeSitter = await import('web-tree-sitter');
        await treeSitter.Parser.init();
        const ParserClass = treeSitter;
        const wasmPath = path.join(__dirname, '..', 'syntaxes', 'tree-sitter-verilog.wasm');
        if (!fs.existsSync(wasmPath)) {
            throw new Error(`WASM file not found at ${wasmPath}`);
        }
        const Verilog = await treeSitter.Language.load(wasmPath);
        const parserObj = new ParserClass.Parser();
        parserObj.setLanguage(Verilog);
        return parserObj;
    } catch (err) {
        console.error('Failed to initialize tree-sitter parser:', err);
        vscode.window.showWarningMessage('Dependency scanner will use fallback regex parsing.');
        return null;
    }
}

export interface ParameterInfo {
    name: string;
    type?: string;
    width?: string;
    default?: string;
}

export interface PortInfo {
    name: string;
    direction: 'input' | 'output' | 'inout';
    type?: string;
    width?: string;
}

export interface ModuleInfo {
    name: string;
    file: string;
    kind: 'module' | 'package' | 'interface' | 'import' | 'undefined';
    instances: { instanceName: string; moduleName: string }[];
    range?: { line: number; character: number };
    parameters?: ParameterInfo[];
    ports?: PortInfo[];
}

export class DependencyScanner {
    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    private modules: Map<string, ModuleInfo> = new Map();
    private cycles: string[][] = [];
    private fileInfoMap = new Map<string, {
        mtime: number;
        modules: ModuleInfo[];
        instances: { 
            instanceName: string; 
            moduleName: string; 
            owner: string
        }[];
    }>();
    private lastReportedCycles: string[][] = [];
    private lastReportedDuplicates: Map<string, { file: string; range: { line: number; character: number } }[]> = new Map();
    private duplicateDiagnosticCollection: vscode.DiagnosticCollection;
    private duplicateOutputChannel: vscode.OutputChannel;
    private cycleOutputChannel: vscode.OutputChannel;
    private timer: NodeJS.Timeout | undefined;
    private parser: any = null;
    private parserReady: Promise<void> | null = null;
    private startRequested: boolean = false;
    private viewType: string;

    constructor(private context: vscode.ExtensionContext, viewType: string) {
        this.viewType = viewType;
        this.duplicateDiagnosticCollection = vscode.languages.createDiagnosticCollection(`verilog-duplicate-${viewType}`);
        this.duplicateOutputChannel = vscode.window.createOutputChannel(`Verilog Duplicate Definitions (${viewType})`);
        this.cycleOutputChannel = vscode.window.createOutputChannel(`Verilog Cyclic Dependencies (${viewType})`);
        this.parserReady = initParser().then(p => {
            this.parser = p;
            console.log(`Tree-sitter parser initialized for ${viewType} dependency scanning`);
            if (this.startRequested) this.doStart();
        }).catch(err => {
            console.error(`Parser initialization failed for ${viewType}:`, err);
            if (this.startRequested) this.doStart();
        });
    }

    start() {
        if (this.timer) return;
        this.startRequested = true;
        if (this.parserReady) {
            this.parserReady.then(() => this.doStart());
        } else {
            this.doStart();
        }
    }

    private doStart() {
        if (this.timer) return;
        const config = vscode.workspace.getConfiguration('verilog');
        const enable = config.get<boolean>('dependencyScanEnable', true);
        if (!enable) return;
        const interval = config.get<number>('dependencyScanInterval', 1000);
        this.timer = setInterval(() => this.scan(), interval);
        this.scan();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.startRequested = false;
    }

    dispose() {
        this.duplicateDiagnosticCollection?.dispose();
        this.duplicateOutputChannel?.dispose();
        this.cycleOutputChannel?.dispose();
    }

    private printTree(node: any, depth: number) {
        const indent = '  '.repeat(depth);
        console.log(`${indent}${node.type} : "${node.text}"`);
        for (const child of node.children) {
            this.printTree(child, depth + 1);
        }
    }
    private treePrinted = false;

    // 获取可序列化的缓存数据
    public getCacheData(): any {
        const fileInfoMapSerializable: any = {};
        for (const [file, info] of this.fileInfoMap) {
            fileInfoMapSerializable[file] = {
                mtime: info.mtime,
                modules: info.modules.map(m => ({
                    ...m,
                    range: m.range ? { line: m.range.line, character: m.range.character } : undefined
                })),
                instances: info.instances
            };
        }
        return {
            fileInfoMap: fileInfoMapSerializable,
            modules: Array.from(this.modules.entries()).map(([name, mod]) => [name, { ...mod, range: mod.range ? { ...mod.range } : undefined }]),
            cycles: this.cycles,
            lastReportedCycles: this.lastReportedCycles,
            lastReportedDuplicates: Array.from(this.lastReportedDuplicates.entries()).map(([name, locs]) => [name, locs.map(l => ({ ...l }))])
        };
    }

    // 从缓存数据恢复状态
    public loadCache(data: any): void {
        if (!data) return;
        // 恢复 fileInfoMap
        const newFileInfoMap = new Map();
        for (const [file, info] of Object.entries(data.fileInfoMap)) {
            const fileInfo: any = info;
            newFileInfoMap.set(file, {
                mtime: fileInfo.mtime,
                modules: fileInfo.modules.map((m: any) => ({ ...m })),
                instances: fileInfo.instances.map((i: any) => ({ ...i }))
            });
        }
        this.fileInfoMap = newFileInfoMap;

        // 恢复 modules
        const newModules = new Map();
        for (const [name, mod] of data.modules) {
            newModules.set(name, { ...mod });
        }
        this.modules = newModules;

        // 恢复 cycles 等
        this.cycles = data.cycles || [];
        this.lastReportedCycles = data.lastReportedCycles || [];
        this.lastReportedDuplicates = new Map(data.lastReportedDuplicates || []);

        // 触发更新，让树视图刷新
        this._onDidUpdate.fire();
    }

    private async addOrUpdateFile(file: string, useRegex: boolean) {
        const content = await readFile(file, 'utf8');
        const modulesInFile: ModuleInfo[] = [];
        const instancesInFile: { instanceName: string; moduleName: string; owner: string }[] = [];

        if (!useRegex && this.parser) {
            const tree = this.parser.parse(content);
            // if (!this.treePrinted) {
            //     this.printTree(tree.rootNode, 0);
            //     this.treePrinted = true;
            // }
            const findChild = (node: any, type: string): any => {
                return node.children.find((c: any) => c.type === type);
            };

            // 递归遍历 AST
            const visit = (node: any, currentModule: string | null, currentPackage: string | null) => {
                // 模块声明
                if (node.type === 'module_declaration') {
                    // 1. 提取模块名
                    const header = findChild(node, 'module_header');
                    let modName = '';
                    if (header) {
                        const nameNode = findChild(header, 'simple_identifier');
                        if (nameNode) modName = nameNode.text;
                    }
                    if (!modName) {
                        // 未找到模块名，继续递归子节点
                        for (const child of node.children) visit(child, currentModule, currentPackage);
                        return;
                    }

                    const startPos = node.startPosition;
                    const range = { line: startPos.row, character: startPos.column };
                    const moduleInfo: ModuleInfo = {
                        name: modName,
                        file,
                        kind: 'module',
                        instances: [],
                        range,
                        parameters: [],
                        ports: []
                    };
                    modulesInFile.push(moduleInfo);

                    // 2. 解析模块的 ANSI 头部（参数和端口）
                    const ansiHeader = findChild(node, 'module_ansi_header');
                    if (ansiHeader) {
                        // 2.1 解析参数列表
                        const paramPortList = findChild(ansiHeader, 'parameter_port_list');
                        if (paramPortList) {
                            const portDecls = paramPortList.children.filter((c: any) => c.type === 'parameter_port_declaration');
                            for (const portDecl of portDecls) {
                                // 尝试找 parameter_declaration 或 local_parameter_declaration
                                let paramDecl = findChild(portDecl, 'parameter_declaration') || findChild(portDecl, 'local_parameter_declaration');
                                if (paramDecl) {
                                    // 有 parameter 或 localparam 关键字
                                    const assignList = findChild(paramDecl, 'list_of_param_assignments');
                                    if (assignList) {
                                        const paramAssigns = assignList.children.filter((c: any) => c.type === 'param_assignment');
                                        for (const assign of paramAssigns) {
                                            const nameNode = findChild(assign, 'parameter_identifier');
                                            if (nameNode) {
                                                const simpleId = findChild(nameNode, 'simple_identifier');
                                                if (simpleId) {
                                                    const paramName = simpleId.text;
                                                    const defaultNode = findChild(assign, 'constant_param_expression');
                                                    let defaultValue = '';
                                                    if (defaultNode) defaultValue = defaultNode.text;
                                                    moduleInfo.parameters!.push({ name: paramName, default: defaultValue });
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    // 省略 parameter 关键字的情况
                                    const dataTypeNode = findChild(portDecl, 'data_type');
                                    if (dataTypeNode) {
                                        const simpleId = findChild(dataTypeNode, 'simple_identifier');
                                        if (simpleId) {
                                            const paramName = simpleId.text;
                                            const assignList = findChild(portDecl, 'list_of_param_assignments');
                                            if (assignList) {
                                                const paramAssigns = assignList.children.filter((c: any) => c.type === 'param_assignment');
                                                for (const assign of paramAssigns) {
                                                    const defaultNode = findChild(assign, 'constant_param_expression');
                                                    let defaultValue = '';
                                                    if (defaultNode) defaultValue = defaultNode.text;
                                                    moduleInfo.parameters!.push({ name: paramName, default: defaultValue });
                                                }
                                            } else {
                                                moduleInfo.parameters!.push({ name: paramName, default: '' });
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // 2.2 解析端口列表
                        const portList = findChild(ansiHeader, 'list_of_port_declarations');
                        if (portList) {
                            const portDecls = portList.children.filter((c: any) => c.type === 'ansi_port_declaration');
                            for (const decl of portDecls) {
                                let direction: 'input' | 'output' | 'inout' = 'input';
                                let type = '';
                                let width = '';
                                let isNet = false;

                                // 方向：先找 net_port_header1 或 variable_port_header
                                let portHeader = findChild(decl, 'net_port_header1');
                                if (portHeader) {
                                    isNet = true;
                                } else {
                                    portHeader = findChild(decl, 'variable_port_header');
                                }

                                if (portHeader) {
                                    // 方向
                                    const dirNode = findChild(portHeader, 'port_direction');
                                    if (dirNode) {
                                        const dirChild = dirNode.children.find((c: any) => c.type === 'input' || c.type === 'output' || c.type === 'inout');
                                        if (dirChild) direction = dirChild.type as 'input' | 'output' | 'inout';
                                    }

                                    // 类型和宽度
                                    if (isNet) {
                                        // net_port_header1：可能有 net_port_type1 或 data_type
                                        const netPortType = findChild(portHeader, 'net_port_type1');
                                        if (netPortType) {
                                            // 尝试找 simple_identifier（自定义类型）
                                            const simpleId = findChild(netPortType, 'simple_identifier');
                                            if (simpleId) {
                                                type = simpleId.text;
                                            } else {
                                                // 可能只有 packed_dimension，类型为隐式 wire
                                                const dim = findChild(netPortType, 'packed_dimension');
                                                if (dim) width = dim.text;
                                                // 类型默认为 wire，但先不设，稍后统一设置
                                            }
                                        } else {
                                            // 没有 net_port_type1，类型默认为 wire
                                            // type = 'wire'; // 先不设，保持空，后面统一
                                        }
                                        // 宽度可能直接在 net_port_type1 的 packed_dimension 中
                                        if (!width) {
                                            const dim = findChild(portHeader, 'packed_dimension');
                                            if (dim) width = dim.text;
                                        }
                                    } else {
                                        // variable_port_header：从 data_type 获取
                                        const dataTypeNode = findChild(portHeader, 'data_type');
                                        if (dataTypeNode) {
                                            // 可能为 integer_vector_type（如 logic）或 simple_identifier（如 my_struct_t）
                                            const intVec = findChild(dataTypeNode, 'integer_vector_type');
                                            if (intVec) {
                                                type = intVec.text;
                                            } else {
                                                const simpleId = findChild(dataTypeNode, 'simple_identifier');
                                                if (simpleId) type = simpleId.text;
                                            }
                                            const dim = findChild(dataTypeNode, 'packed_dimension');
                                            if (dim) width = dim.text;
                                        }
                                    }
                                }

                                // 如果类型为空且是 net，默认为 wire
                                if (isNet && !type) type = 'wire';

                                // 端口名
                                const portIdNode = findChild(decl, 'port_identifier');
                                if (portIdNode) {
                                    const simpleId = findChild(portIdNode, 'simple_identifier');
                                    if (simpleId) {
                                        const portName = simpleId.text;
                                        moduleInfo.ports!.push({ name: portName, direction, type, width });
                                    }
                                }
                            }
                        }
                    }

                    // 3. 递归遍历模块体，收集实例化和导入
                    for (const child of node.children) {
                        visit(child, modName, currentPackage);
                    }
                    return; // 模块已处理，避免重复递归
                }

                // 包声明
                if (node.type === 'package_declaration') {
                    const startPos = node.startPosition;
                    const range = { line: startPos.row, character: startPos.column };
                    const nameNode = findChild(node, 'package_identifier');
                    if (nameNode) {
                        const simpleId = findChild(nameNode, 'simple_identifier');
                        if (simpleId) {
                            const pkgName = simpleId.text;
                            modulesInFile.push({
                                name: pkgName,
                                file,
                                kind: 'package',
                                instances: [],
                                range
                            });
                            for (const child of node.children) {
                                visit(child, currentModule, pkgName);
                            }
                            return;
                        }
                    }
                }

                // 接口声明
                if (node.type === 'interface_declaration') {
                    const startPos = node.startPosition;
                    const range = { line: startPos.row, character: startPos.column };
                    const ansiHeader = findChild(node, 'interface_ansi_header');
                    if (ansiHeader) {
                        const nameNode = findChild(ansiHeader, 'interface_identifier');
                        if (nameNode) {
                            const simpleId = findChild(nameNode, 'simple_identifier');
                            if (simpleId) {
                                modulesInFile.push({
                                    name: simpleId.text,
                                    file,
                                    kind: 'interface',
                                    instances: [],
                                    range
                                });
                            }
                        }
                    }
                }

                // 模块实例化
                if (node.type === 'module_instantiation' && (currentModule || currentPackage)) {
                    const moduleNameNode = findChild(node, 'simple_identifier');
                    const hierarchical = findChild(node, 'hierarchical_instance');
                    let instanceName = '';
                    if (hierarchical) {
                        const nameNode = findChild(hierarchical, 'name_of_instance');
                        if (nameNode) {
                            const idNode = findChild(nameNode, 'instance_identifier');
                            if (idNode) {
                                const simple = findChild(idNode, 'simple_identifier');
                                if (simple) instanceName = simple.text;
                            }
                        }
                    }
                    if (moduleNameNode) {
                        const moduleName = moduleNameNode.text;
                        const owner = currentModule || currentPackage!;
                        instancesInFile.push({ instanceName, moduleName, owner });
                    }
                }

                // 接口实例化（checker_instantiation）
                // if (node.type === 'checker_instantiation' && (currentModule || currentPackage)) {
                //     const ifaceNode = findChild(node, 'checker_identifier');
                //     const nameOfInstance = findChild(node, 'name_of_instance');
                //     let instanceName = '';
                //     if (nameOfInstance) {
                //         const idNode = findChild(nameOfInstance, 'instance_identifier');
                //         if (idNode) {
                //             const simple = findChild(idNode, 'simple_identifier');
                //             if (simple) instanceName = simple.text;
                //         }
                //     }
                //     if (ifaceNode) {
                //         const simpleId = findChild(ifaceNode, 'simple_identifier');
                //         if (simpleId) {
                //             const ifaceName = simpleId.text;
                //             const owner = currentModule || currentPackage!;
                //             instancesInFile.push({ instanceName, moduleName: ifaceName, owner });
                //         }
                //     }
                // }

                // 包导入
                if (node.type === 'package_import_declaration' && (currentModule || currentPackage)) {
                    const packageItem = findChild(node, 'package_import_item');
                    if (packageItem) {
                        const pkgNode = findChild(packageItem, 'package_identifier');
                        if (pkgNode) {
                            const simpleId = findChild(pkgNode, 'simple_identifier');
                            if (simpleId) {
                                const pkgName = simpleId.text;
                                const owner = currentModule || currentPackage!;
                                instancesInFile.push({ instanceName: 'import', moduleName: pkgName, owner });
                            }
                        }
                    }
                }

                // 递归子节点（避免重复处理模块和包）
                if (node.type !== 'module_declaration' && node.type !== 'package_declaration') {
                    for (const child of node.children) {
                        visit(child, currentModule, currentPackage);
                    }
                }
            };

            visit(tree.rootNode, null, null);
        } else {
            // 正则 fallback（简化）
            const moduleNames = this.extractModuleNamesRegex(content);
            const instances = this.extractInstancesRegex(content);
            for (const modName of moduleNames) {
                modulesInFile.push({
                    name: modName,
                    file,
                    kind: 'module',
                    instances: [],
                    range: undefined
                });
            }
            for (const inst of instances) {
                instancesInFile.push({ instanceName: inst.instanceName, moduleName: inst.moduleName, owner: '' });
            }
        }

        const mtime = (await fs.promises.stat(file)).mtimeMs;
        this.fileInfoMap.set(file, { mtime, modules: modulesInFile, instances: instancesInFile });
    }

    private removeFile(file: string) {
        this.fileInfoMap.delete(file);
    }

    private generateDefinitions(): Map<string, { file: string; range: { line: number; character: number } }[]> {
        const definitions = new Map();
        for (const [file, info] of this.fileInfoMap) {
            for (const mod of info.modules) {
                if (mod.range) {
                    const list = definitions.get(mod.name) || [];
                    list.push({ file, range: mod.range });
                    definitions.set(mod.name, list);
                }
            }
        }
        return definitions;
    }

    async scan() {
        const config = vscode.workspace.getConfiguration('verilog');
        const useRegex = config.get<boolean>('dependencyScan.useRegex', false);

        let projectFoldersConfig: string[] = [];
        if (this.viewType === 'src') {
            projectFoldersConfig = config.get<string[]>('srcFolders', []);
        } else if (this.viewType === 'sim') {
            projectFoldersConfig = config.get<string[]>('simFolders', []);
        } else if (this.viewType === 'soc') {
            projectFoldersConfig = config.get<string[]>('socFolders', []);
        } else {
            projectFoldersConfig = config.get<string[]>('projectFolder', []);
        }

        if (projectFoldersConfig.length === 0) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                projectFoldersConfig = [workspaceFolders[0].uri.fsPath];
            } else {
                return;
            }
        }

        let projectFolders: string[] = [];
        if (Array.isArray(projectFoldersConfig)) {
            projectFolders = projectFoldersConfig;
        } else if (typeof projectFoldersConfig === 'string' && projectFoldersConfig) {
            projectFolders = [projectFoldersConfig];
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const rootPath = workspaceFolders[0].uri.fsPath;

        let baseDirs: string[] = [];
        if (projectFolders.length === 0) {
            baseDirs = [rootPath];
        } else {
            for (const folder of projectFolders) {
                const fullPath = path.isAbsolute(folder) ? folder : path.join(rootPath, folder);
                if (fs.existsSync(fullPath)) {
                    baseDirs.push(fullPath);
                } else {
                    vscode.window.showWarningMessage(`Project folder does not exist: ${fullPath}`);
                }
            }
        }

        if (baseDirs.length === 0) {
            vscode.window.showErrorMessage('No valid project folders found.');
            return;
        }

        const allFiles = new Set<string>();
        for (const dir of baseDirs) {
            const files = await this.findVerilogFiles(dir);
            for (const file of files) allFiles.add(file);
        }
        const files = Array.from(allFiles);

        const currentFiles = new Map<string, number>();
        for (const file of files) {
            try {
                const stat = await fs.promises.stat(file);
                currentFiles.set(file, stat.mtimeMs);
            } catch (err) {
                // ignore
            }
        }

        const deletedFiles: string[] = [];
        const changedFiles: string[] = [];
        for (const [file, info] of this.fileInfoMap) {
            if (!currentFiles.has(file)) {
                deletedFiles.push(file);
            } else if (currentFiles.get(file) !== info.mtime) {
                changedFiles.push(file);
            }
        }
        const addedFiles = Array.from(currentFiles.keys()).filter(file => !this.fileInfoMap.has(file));

        if (deletedFiles.length === 0 && changedFiles.length === 0 && addedFiles.length === 0) {
            return;
        }

        for (const file of deletedFiles) {
            this.removeFile(file);
        }
        for (const file of changedFiles) {
            this.removeFile(file);
            await this.addOrUpdateFile(file, useRegex);
        }
        for (const file of addedFiles) {
            await this.addOrUpdateFile(file, useRegex);
        }

        const modules = new Map<string, ModuleInfo>();
        const allInstances: { instanceName: string; moduleName: string; owner: string }[] = [];
        for (const [file, info] of this.fileInfoMap) {
            for (const mod of info.modules) {
                if (!modules.has(mod.name)) {
                    modules.set(mod.name, { ...mod, instances: [] });
                }
            }
            allInstances.push(...info.instances);
        }
        for (const inst of allInstances) {
            const mod = modules.get(inst.owner);
            if (mod) {
                if (!mod.instances.some(i => i.instanceName === inst.instanceName && i.moduleName === inst.moduleName)) {
                    mod.instances.push({ instanceName: inst.instanceName, moduleName: inst.moduleName });
                }
            }
        }

        const allInstanceNames = new Set<string>();
        for (const info of this.fileInfoMap.values()) {
            for (const inst of info.instances) {
                allInstanceNames.add(inst.moduleName);
            }
        }
        for (const instName of allInstanceNames) {
            if (!modules.has(instName)) {
                modules.set(instName, {
                    name: instName,
                    file: '',
                    kind: 'undefined',
                    instances: []
                });
            }
        }

        this.modules = modules;
        this.detectDuplicates(this.generateDefinitions());
        this.detectCycles();
        this._onDidUpdate.fire();
    }

    private async findVerilogFiles(dir: string): Promise<string[]> {
        const files: string[] = [];
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== '.' && entry.name !== '..' && !entry.name.startsWith('.')) {
                    files.push(...(await this.findVerilogFiles(fullPath)));
                }
            } else if (entry.isFile() && (entry.name.endsWith('.v') || entry.name.endsWith('.sv'))) {
                files.push(fullPath);
            }
        }
        return files;
    }

    private extractModuleNamesRegex(content: string): string[] {
        const names: string[] = [];
        const regex = /^\s*module\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*(?:\(|;)/gm;
        let match;
        while ((match = regex.exec(content)) !== null) names.push(match[1]);
        return names;
    }

    private extractInstancesRegex(content: string): { instanceName: string; moduleName: string }[] {
        const instances: { instanceName: string; moduleName: string }[] = [];
        const regex = /(\w+)\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*\(/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            instances.push({ instanceName: match[2], moduleName: match[1] });
        }
        return instances;
    }

    private detectCycles() {
        const graph: Map<string, string[]> = new Map();
        for (const [mod, info] of this.modules) {
            const deps = info.instances
                .filter(i => i.instanceName !== 'import')
                .map(i => i.moduleName);
            graph.set(mod, deps);
        }
        const visited = new Set<string>();
        const stack = new Set<string>();
        const cycles: string[][] = [];

        const dfs = (node: string, path: string[]) => {
            if (stack.has(node)) {
                const cycleStart = path.indexOf(node);
                const cycle = path.slice(cycleStart);
                cycles.push(cycle);
                return;
            }
            if (visited.has(node)) return;
            visited.add(node);
            stack.add(node);
            const neighbors = graph.get(node) || [];
            for (const neighbor of neighbors) {
                dfs(neighbor, [...path, neighbor]);
            }
            stack.delete(node);
        };

        for (const node of graph.keys()) {
            dfs(node, [node]);
        }

        const uniqueCycles: string[][] = [];
        const cycleSet = new Set<string>();
        for (const cycle of cycles) {
            const key = cycle.join('->');
            if (!cycleSet.has(key)) {
                cycleSet.add(key);
                uniqueCycles.push(cycle);
            }
        }

        const currentKey = uniqueCycles.map(c => c.join('->')).sort().join('|');
        const lastKey = this.lastReportedCycles.map(c => c.join('->')).sort().join('|');
        if (currentKey !== lastKey) {
            this.cycles = uniqueCycles;
            this.lastReportedCycles = uniqueCycles;
            this.reportCycles();
        } else {
            this.cycles = uniqueCycles;
        }
    }

    private detectDuplicates(definitions: Map<string, { file: string; range: { line: number; character: number } }[]>) {
        const duplicates: { name: string; locations: { file: string; range: { line: number; character: number } }[] }[] = [];
        for (const [name, locs] of definitions) {
            if (locs.length > 1) {
                duplicates.push({ name, locations: locs });
            }
        }
        const currentKey = duplicates.map(d => `${d.name}:${d.locations.map(l => `${l.file}:${l.range.line}:${l.range.character}`).join(',')}`).sort().join('|');
        const lastKey = Array.from(this.lastReportedDuplicates.entries()).map(([name, locs]) => `${name}:${locs.map(l => `${l.file}:${l.range.line}:${l.range.character}`).join(',')}`).sort().join('|');
        if (currentKey === lastKey) return;

        this.lastReportedDuplicates.clear();
        for (const d of duplicates) {
            this.lastReportedDuplicates.set(d.name, d.locations);
        }

        const fileDiagnostics = new Map<string, vscode.Diagnostic[]>();
        for (const dup of duplicates) {
            for (const loc of dup.locations) {
                const range = new vscode.Range(loc.range.line, loc.range.character, loc.range.line, loc.range.character + 1);
                const otherLocs = dup.locations.filter(l => 
                    !(l.file === loc.file && l.range.line === loc.range.line && l.range.character === loc.range.character)
                );
                const message = `Duplicate definition of ${dup.name}. Also defined at: ${otherLocs.map(l => `${l.file}:${l.range.line+1}:${l.range.character+1}`).join(', ')}`;
                const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
                if (!fileDiagnostics.has(loc.file)) fileDiagnostics.set(loc.file, []);
                fileDiagnostics.get(loc.file)!.push(diagnostic);
            }
        }
        this.duplicateDiagnosticCollection.clear();
        for (const [file, diags] of fileDiagnostics) {
            this.duplicateDiagnosticCollection.set(vscode.Uri.file(file), diags);
        }

        this.duplicateOutputChannel.appendLine(`Duplicate definitions detected in ${this.viewType} view:`);
        for (const dup of duplicates) {
            this.duplicateOutputChannel.appendLine(`${dup.name}:`);
            for (const loc of dup.locations) {
                this.duplicateOutputChannel.appendLine(`  at ${loc.file}:${loc.range.line+1}:${loc.range.character+1}`);
            }
        }
        this.duplicateOutputChannel.show(true);
    }

    private reportCycles() {
        const diagnosticCollection = vscode.languages.createDiagnosticCollection(`verilog-dependency-${this.viewType}`);
        diagnosticCollection.clear();
        if (this.cycles.length === 0) {
            this.cycleOutputChannel.appendLine(`No cyclic dependencies detected in ${this.viewType} view.`);
            this.cycleOutputChannel.show(true);
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];
        for (const cycle of this.cycles) {
            const message = `Cyclic dependency detected: ${cycle.join(' -> ')}`;
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 0),
                message,
                vscode.DiagnosticSeverity.Error
            );
            diagnostics.push(diagnostic);
        }
        diagnosticCollection.set(vscode.Uri.file(`virtual://dependency-${this.viewType}`), diagnostics);

        this.cycleOutputChannel.appendLine(`Cyclic dependencies detected in ${this.viewType} view:`);
        for (const cycle of this.cycles) this.cycleOutputChannel.appendLine(cycle.join(' -> '));
        this.cycleOutputChannel.show(true);
    }

    getModules(): Map<string, ModuleInfo> {
        return this.modules;
    }

    getCycles(): string[][] {
        return this.cycles;
    }
}
