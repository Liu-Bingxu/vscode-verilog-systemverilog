import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyScanner, ModuleInfo } from './dependencyScanner';
import { ModuleTreeProvider, ModuleTreeNode } from './moduleTreeProvider';


let diagnosticCollection: vscode.DiagnosticCollection;
let pendingTimeout: NodeJS.Timeout | undefined;
let srcScanner: DependencyScanner;
let simScanner: DependencyScanner;
let socScanner: DependencyScanner;

// 错误代码描述映射
const codeDescriptions: Map<string, string> = new Map([
    ['WIDTH', 'Width mismatch: Check bit widths of expressions.'],
    ['UNUSED', 'Signal is unused.'],
    ['COMBDLY', 'Delayed assignments in combinational blocks may cause simulation mismatches.'],
    ['INITIALDLY', 'Delayed assignments in initial blocks may not be synthesizable.'],
    ['STMTDLY', 'Delayed assignments are ignored for synthesis.'],
    ['ALWCOMBORDER', 'Inconsistent order of blocking assignments in always_comb block.'],
    ['CASEINCOMPLETE', 'Case statement not fully covered.'],
    ['CASEX', 'Casex statements are non-synthesizable.'],
    ['CASEWITHX', 'Case statement with x or z may not be synthesizable.'],
    ['BLKSEQ', 'Blocking assignment in sequential block.'],
    ['LATCH', 'Latch inferred.'],
    ['UNOPTFLAT', 'Unoptimizable flat hierarchy.'],
    ['UNOPT', 'Unoptimizable.'],
    ['UNPACKED', 'Unpacked array usage.'],
    ['UNSIGNED', 'Unsigned comparison.'],
    ['VARHIDDEN', 'Variable hidden by another declaration.'],
]);

const defaultDescription = 'No additional description available.';

export function activate(context: vscode.ExtensionContext) {
    console.log('Verilog Lint extension activated');

    const config = vscode.workspace.getConfiguration('verilog');
    const cacheEnable = config.get<boolean>('dependencyCache.enable', true);
    const askBeforeCreate = config.get<boolean>('dependencyCache.askBeforeCreate', true);
    const cacheDir = config.get<string>('dependencyCache.directory', '.vscode');

    diagnosticCollection = vscode.languages.createDiagnosticCollection('verilator');
    context.subscriptions.push(diagnosticCollection);

    // 创建三个扫描器
    srcScanner = new DependencyScanner(context, 'src');
    simScanner = new DependencyScanner(context, 'sim');
    socScanner = new DependencyScanner(context, 'soc');

    // 创建树视图提供者
    const moduleTreeProvider = new ModuleTreeProvider(srcScanner, 'module', context);
    const simTreeProvider = new ModuleTreeProvider(simScanner, 'sim', context);
    const socTreeProvider = new ModuleTreeProvider(socScanner, 'soc', context);
    const moduleTree = vscode.window.createTreeView('verilog.moduleTree', {
        treeDataProvider: moduleTreeProvider,
        showCollapseAll: true
    });
    const simTree = vscode.window.createTreeView('verilog.simTree', {
        treeDataProvider: simTreeProvider,
        showCollapseAll: true
    });
    const socTree = vscode.window.createTreeView('verilog.socTree', {
        treeDataProvider: socTreeProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(moduleTree, simTree, socTree);

    // 刷新命令
    const refreshCmd = vscode.commands.registerCommand('verilog.refreshModuleTree', () => moduleTreeProvider.refresh());
    const refreshSim = vscode.commands.registerCommand('verilog.refreshSimTree', () => simTreeProvider.refresh());
    const refreshSoc = vscode.commands.registerCommand('verilog.refreshSocTree', () => socTreeProvider.refresh());
    context.subscriptions.push(refreshCmd, refreshSim, refreshSoc);

    // 设置顶层模块命令
    const setTopSrc = vscode.commands.registerCommand('verilog.setAsTopSrc', (node: any) => {
        if (!node || !node.info || node.info.kind !== 'module') return;
        if (!moduleTreeProvider.isTopLevel(node.label)) {
            vscode.window.showWarningMessage(`Module "${node.label}" is not a top-level module and cannot be set as top.`);
            return;
        }
        context.workspaceState.update('moduleTopModule', node.label);
        moduleTreeProvider.refresh();
    });
    const setTopSim = vscode.commands.registerCommand('verilog.setAsTopSim', (node: any) => {
        if (!node || !node.info || node.info.kind !== 'module') return;
        if (!simTreeProvider.isTopLevel(node.label)) {
            vscode.window.showWarningMessage(`Module "${node.label}" is not a top-level module and cannot be set as top.`);
            return;
        }
        context.workspaceState.update('simTopModule', node.label);
        simTreeProvider.refresh();
    });
    const setTopSoc = vscode.commands.registerCommand('verilog.setAsTopSoc', (node: any) => {
        if (!node || !node.info || node.info.kind !== 'module') return;
        if (!socTreeProvider.isTopLevel(node.label)) {
            vscode.window.showWarningMessage(`Module "${node.label}" is not a top-level module and cannot be set as top.`);
            return;
        }
        context.workspaceState.update('socTopModule', node.label);
        socTreeProvider.refresh();
    });
    context.subscriptions.push(setTopSrc, setTopSim, setTopSoc);

    // 辅助实例化模块命令（三个视图独立）
    const instantiateSrcCmd = vscode.commands.registerCommand('verilog.instantiateSrcModule', async () => {
        await instantiateModuleWithScanner(srcScanner);
    });
    const instantiateSimCmd = vscode.commands.registerCommand('verilog.instantiateSimModule', async () => {
        await instantiateModuleWithScanner(simScanner);
    });
    const instantiateSocCmd = vscode.commands.registerCommand('verilog.instantiateSocModule', async () => {
        await instantiateModuleWithScanner(socScanner);
    });
    context.subscriptions.push(instantiateSrcCmd, instantiateSimCmd, instantiateSocCmd);

    if (cacheEnable && vscode.workspace.workspaceFolders) {
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const cachePath = path.join(rootPath, cacheDir);
        if (!fs.existsSync(cachePath)) {
            fs.mkdirSync(cachePath, { recursive: true });
        }

        // 为每个扫描器加载缓存
        const loadCacheForScanner = (scanner: DependencyScanner, suffix: string) => {
            const cacheFile = path.join(cachePath, `verilog-deps-${suffix}.json`);
            if (fs.existsSync(cacheFile)) {
                try {
                    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                    scanner.loadCache(data);
                    console.log(`Loaded cache for ${suffix} scanner`);
                } catch (err) {
                    console.error(`Failed to load cache for ${suffix}:`, err);
                }
            } else if (askBeforeCreate) {
                // 询问是否创建缓存文件
                vscode.window.showInformationMessage(
                    `Cache file for ${suffix} dependencies not found. Create it?`,
                    'Yes', 'No'
                ).then(choice => {
                    if (choice === 'Yes') {
                        // 创建空文件，触发一次扫描
                        fs.writeFileSync(cacheFile, JSON.stringify({}), 'utf8');
                        // 扫描器会在定时扫描中自动保存
                    }
                });
            }
        };

        loadCacheForScanner(srcScanner, 'src');
        loadCacheForScanner(simScanner, 'sim');
        loadCacheForScanner(socScanner, 'soc');
    }

    // 为每个扫描器添加保存监听（在扫描完成后）
    const saveCacheForScanner = (scanner: DependencyScanner, suffix: string) => {
        scanner.onDidUpdate(() => {
            if (!cacheEnable) return;
            const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!rootPath) return;
            const cachePath = path.join(rootPath, cacheDir);
            const cacheFile = path.join(cachePath, `verilog-deps-${suffix}.json`);
            try {
                const data = scanner.getCacheData();
                fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf8');
            } catch (err) {
                console.error(`Failed to save cache for ${suffix}:`, err);
            }
        });
    };

    saveCacheForScanner(srcScanner, 'src');
    saveCacheForScanner(simScanner, 'sim');
    saveCacheForScanner(socScanner, 'soc');

    // 启动扫描器
    srcScanner.start();
    simScanner.start();
    socScanner.start();

    // 配置变化监听
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('verilog.dependencyScanEnable') ||
            event.affectsConfiguration('verilog.dependencyScanInterval') ||
            event.affectsConfiguration('verilog.dependencyScan.useRegex')) {
            srcScanner.stop(); srcScanner.start();
            simScanner.stop(); simScanner.start();
            socScanner.stop(); socScanner.start();
        }
    });
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('verilog.srcFolders')) {
            srcScanner.stop(); srcScanner.start();
        }
    });
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('verilog.simFolders')) {
            simScanner.stop(); simScanner.start();
        }
    });
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('verilog.socFolders')) {
            socScanner.stop(); socScanner.start();
        }
    });

    // 手动 lint 命令
    const lintCommand = vscode.commands.registerCommand('verilog.lintCurrentFile', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            lintDocument(editor.document);
        }
    });
    context.subscriptions.push(lintCommand);

    // 悬停提示
    const hoverProvider = vscode.languages.registerHoverProvider(
        ['verilog', 'systemverilog'],
        {
            provideHover(document: vscode.TextDocument, position: vscode.Position) {
                const diagnostics = diagnosticCollection.get(document.uri);
                if (!diagnostics) return null;
                const diagAtPos = diagnostics.find(d => d.range.contains(position));
                if (diagAtPos && diagAtPos.code) {
                    const codeStr = diagAtPos.code.toString();
                    const description = codeDescriptions.get(codeStr) || defaultDescription;
                    const hoverContent = new vscode.MarkdownString();
                    hoverContent.appendMarkdown(`**${codeStr}**\n\n`);
                    hoverContent.appendMarkdown(`${description}\n\n`);
                    hoverContent.appendMarkdown(`_${diagAtPos.message}_`);
                    hoverContent.isTrusted = true;
                    return new vscode.Hover(hoverContent);
                }
                return null;
            }
        }
    );
    context.subscriptions.push(hoverProvider);

    // 文档事件
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (isHdlFile(document)) {
                const config = vscode.workspace.getConfiguration('verilog');
                if (config.get<boolean>('lint.enable', true) && config.get<string>('lint.run') === 'onSave') {
                    lintDocument(document);
                }
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const document = event.document;
            if (isHdlFile(document)) {
                const config = vscode.workspace.getConfiguration('verilog');
                if (config.get<boolean>('lint.enable', true) && config.get<string>('lint.run') === 'onType') {
                    if (pendingTimeout) clearTimeout(pendingTimeout);
                    pendingTimeout = setTimeout(() => lintDocument(document), 500);
                }
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            diagnosticCollection.delete(document.uri);
        })
    );

    if (vscode.window.activeTextEditor && isHdlFile(vscode.window.activeTextEditor.document)) {
        lintDocument(vscode.window.activeTextEditor.document);
    }
}

function isHdlFile(document: vscode.TextDocument): boolean {
    return document.languageId === 'verilog' || document.languageId === 'systemverilog';
}

async function lintDocument(document: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('verilog');
    const verilatorPath = config.get<string>('path', 'verilator');
    const extraArgs = config.get<string[]>('lint.arguments', ['-Wall']);
    const includePaths = config.get<string[]>('includePath', []);

    const includeArgs = includePaths.map(p => `-I${p}`);
    const fileName = document.fileName;
    const fileDir = path.dirname(fileName);

    const args = ['--lint-only', ...includeArgs, ...extraArgs, fileName];
    const command = `"${verilatorPath}" ${args.join(' ')}`;

    try {
        const { stdout, stderr } = await execPromise(command, { cwd: fileDir });
        const output = stdout + '\n' + stderr;
        const diagnostics = parseVerilatorOutput(output, document);
        diagnosticCollection.set(document.uri, diagnostics);
    } catch (error: any) {
        if (error.stdout || error.stderr) {
            const output = (error.stdout || '') + '\n' + (error.stderr || '');
            const diagnostics = parseVerilatorOutput(output, document);
            diagnosticCollection.set(document.uri, diagnostics);
        } else {
            vscode.window.showErrorMessage(`Verilator lint failed: ${error.message}`);
            diagnosticCollection.delete(document.uri);
        }
    }
}

function execPromise(command: string, options: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                (error as any).stdout = stdout;
                (error as any).stderr = stderr;
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

function parseVerilatorOutput(output: string, document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const lines = output.split('\n');
    const regex = /^(%[A-Za-z\-]+):\s*([^:]+):(\d+)(?::(\d+))?:\s*(.*)$/;

    for (const line of lines) {
        const match = regex.exec(line);
        if (!match) continue;

        const [, severityStr, filePath, lineStr, colStr, message] = match;
        const lineNum = parseInt(lineStr, 10) - 1;

        if (filePath !== document.fileName) continue;

        let severity: vscode.DiagnosticSeverity;
        if (severityStr.startsWith('%Error') || severityStr.startsWith('%Fatal')) {
            severity = vscode.DiagnosticSeverity.Error;
        } else if (severityStr.startsWith('%Warning')) {
            severity = vscode.DiagnosticSeverity.Warning;
        } else {
            severity = vscode.DiagnosticSeverity.Information;
        }

        let code: string | undefined;
        const codeMatch = severityStr.match(/%[A-Za-z]+-([A-Z0-9_]+)/);
        if (codeMatch) code = codeMatch[1];

        let range: vscode.Range;
        if (colStr) {
            const colNum = parseInt(colStr, 10) - 1;
            const lineText = document.lineAt(lineNum).text;
            range = new vscode.Range(lineNum, colNum, lineNum, lineText.length);
        } else {
            range = new vscode.Range(lineNum, 0, lineNum, document.lineAt(lineNum).text.length);
        }

        const diagnostic = new vscode.Diagnostic(range, message, severity);
        diagnostic.source = 'verilator';
        diagnostic.code = code;
        diagnostics.push(diagnostic);
    }

    return diagnostics;
}

async function instantiateModuleWithScanner(scanner: DependencyScanner) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const modules = scanner.getModules();
    const moduleNames = Array.from(modules.keys()).filter(name => modules.get(name)?.kind === 'module');
    if (moduleNames.length === 0) {
        vscode.window.showWarningMessage('No modules found in this view');
        return;
    }

    const selected = await vscode.window.showQuickPick(moduleNames, {
        placeHolder: 'Select a module to instantiate'
    });
    if (!selected) return;

    const moduleInfo = modules.get(selected);
    if (!moduleInfo || moduleInfo.kind !== 'module') {
        vscode.window.showErrorMessage(`Module ${selected} not found or not a module`);
        return;
    }

    const fileType = editor.document.languageId;
    const cursorOffset = editor.selection.active.character; // 光标所在列的列号（0-based）
    const instantiationCode = generateInstantiation(moduleInfo, fileType, cursorOffset);
    const position = editor.selection.active;
    await editor.edit(editBuilder => {
        editBuilder.insert(position, instantiationCode);
    });
}

function generateInstantiation(moduleInfo: ModuleInfo, fileType: string, cursorOffset: number): string {
    const parameters = moduleInfo.parameters || [];
    const ports = moduleInfo.ports || [];
    const isSV = fileType === 'systemverilog';
    const defaultType = isSV ? 'logic' : 'wire';
    const indent = ' '.repeat(cursorOffset);
    const indent4 = ' '.repeat(cursorOffset + 4);

    function colCount(str: string): number {
        return str.length;
    }

    // ---------- 输出变量声明 ----------
    const outputPorts = ports.filter(p => p.direction === 'output');
    const portLines: { type: string; width: string; name: string }[] = [];
    for (const port of outputPorts) {
        let type = port.type;
        if (!type || type === '') type = defaultType;
        let width = port.width || '';
        portLines.push({ type, width, name: port.name });
    }

    let maxTypeLen = 0;
    let maxWidthLen = 0;
    for (const pl of portLines) {
        maxTypeLen = Math.max(maxTypeLen, colCount(pl.type));
        maxWidthLen = Math.max(maxWidthLen, colCount(pl.width));
    }

    const typeStart = 0;
    const widthStart = Math.ceil((maxTypeLen + 1) / 4) * 4;
    const nameStart = Math.ceil((widthStart + maxWidthLen + 1) / 4) * 4;

    const varDeclLines: string[] = [];
    for (const pl of portLines) {
        const typePart = pl.type;
        const widthPart = pl.width;
        const namePart = pl.name;
        const typeSpaces = widthStart - colCount(typePart);
        const widthSpaces = nameStart - (widthStart + colCount(widthPart));
        varDeclLines.push(`${indent}${typePart}${' '.repeat(typeSpaces)}${widthPart}${' '.repeat(widthSpaces)}${namePart};`);
    }

    // ---------- 参数列表 ----------
    const paramLines = parameters.map(p => ({ name: p.name, value: p.name }));
    let maxParamNameLen = 0;
    let maxValueLen = 0;
    for (const p of paramLines) {
        maxParamNameLen = Math.max(maxParamNameLen, colCount(p.name));
        maxValueLen = Math.max(maxValueLen, colCount(p.value));
    }

    // 左括号的绝对列（相对于行首，即 indent4 之前的部分）
    // 我们希望左括号的绝对列是 4 的倍数，且至少比 ".name" 的绝对列大 2（点+至少一个空格）
    const baseCol = cursorOffset + 4; // indent4 的起始列
    const dotNameAbsCol = (name: string) => baseCol + colCount(`.${name}`);
    let leftParenAbsCol = 0;
    for (const p of paramLines) {
        const minCol = dotNameAbsCol(p.name) + 2; // 至少一个空格
        leftParenAbsCol = Math.max(leftParenAbsCol, Math.ceil(minCol / 4) * 4);
    }
    // 右括号的绝对列，需要大于等于 leftParenAbsCol + 1 (左括号) + 1 (空格) + maxValueLen + 1 (空格)
    const minRightParenAbsCol = leftParenAbsCol + 1 + 1 + maxValueLen + 1;
    const rightParenAbsCol = Math.ceil(minRightParenAbsCol / 4) * 4;

    // 计算每个参数需要的空格
    const paramStrs: string[] = [];
    for (let i = 0; i < paramLines.length; i++) {
        const p = paramLines[i];
        const dotName = `.${p.name}`;
        const spacesToLeftParen = leftParenAbsCol - (baseCol + colCount(dotName));
        const valueStr = p.value;
        const leftParenCol = baseCol + colCount(dotName) + spacesToLeftParen; // 左括号的绝对列
        const spacesToRightParen = rightParenAbsCol - (leftParenCol + 1 + colCount(valueStr) + 1);
        const isLast = i === paramLines.length - 1;
        const comma = isLast ? '' : ',';
        paramStrs.push(`${indent4}${dotName}${' '.repeat(spacesToLeftParen)}( ${valueStr}${' '.repeat(spacesToRightParen)} )${comma}`);
    }

    // ---------- 端口连接 ----------
    const portConnLines = ports.map(p => ({ name: p.name, value: p.name }));
    let maxPortNameLen = 0;
    let maxPortValueLen = 0;
    for (const p of portConnLines) {
        maxPortNameLen = Math.max(maxPortNameLen, colCount(p.name));
        maxPortValueLen = Math.max(maxPortValueLen, colCount(p.value));
    }

    // 左括号绝对列
    let leftParenAbsColPort = 0;
    for (const p of portConnLines) {
        const minCol = dotNameAbsCol(p.name) + 2;
        leftParenAbsColPort = Math.max(leftParenAbsColPort, Math.ceil(minCol / 4) * 4);
    }
    const minRightParenAbsColPort = leftParenAbsColPort + 1 + 1 + maxPortValueLen + 1;
    const rightParenAbsColPort = Math.ceil(minRightParenAbsColPort / 4) * 4;

    const portStrs: string[] = [];
    for (let i = 0; i < portConnLines.length; i++) {
        const p = portConnLines[i];
        const dotName = `.${p.name}`;
        const spacesToLeftParen = leftParenAbsColPort - (baseCol + colCount(dotName));
        const valueStr = p.value;
        const leftParenCol = baseCol + colCount(dotName) + spacesToLeftParen;
        const spacesToRightParen = rightParenAbsColPort - (leftParenCol + 1 + colCount(valueStr) + 1);
        const isLast = i === portConnLines.length - 1;
        const comma = isLast ? '' : ',';
        portStrs.push(`${indent4}${dotName}${' '.repeat(spacesToLeftParen)}( ${valueStr}${' '.repeat(spacesToRightParen)} )${comma}`);
    }

    // ---------- 构建最终代码 ----------
    const lines: string[] = [];

    // localparam 声明
    for (const param of parameters) {
        lines.push(`${indent}localparam ${param.name} = ${param.name};`);
    }
    if (parameters.length > 0) lines.push('');

    // 输出变量声明（注释在之前）
    if (outputPorts.length > 0) {
        lines.push(`${indent}// output from u_${moduleInfo.name}`);
        lines.push(...varDeclLines);
        lines.push('');
    }

    // 实例化主体
    if (parameters.length > 0) {
        lines.push(`${indent}${moduleInfo.name} #(`);
        lines.push(...paramStrs);
        lines.push(`${indent}) u_${moduleInfo.name} (`);
    } else {
        lines.push(`${indent}${moduleInfo.name} u_${moduleInfo.name} (`);
    }
    lines.push(...portStrs);
    lines.push(`${indent});`);

    // 去除第一行的额外缩进（因为光标前已有空格）
    if (lines.length > 0 && lines[0].startsWith(indent)) {
        lines[0] = lines[0].substring(cursorOffset);
    }

    return lines.join('\n');
}

export function deactivate() {
    if (pendingTimeout) clearTimeout(pendingTimeout);
    diagnosticCollection?.clear();
    if (srcScanner) srcScanner.dispose();
    if (simScanner) simScanner.dispose();
    if (socScanner) socScanner.dispose();
    if (srcScanner) srcScanner.stop();
    if (simScanner) simScanner.stop();
    if (socScanner) socScanner.stop();
}
