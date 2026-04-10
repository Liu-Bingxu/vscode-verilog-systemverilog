import * as vscode from 'vscode';
import { Parser } from 'web-tree-sitter';
import { DependencyScanner, ModuleInfo } from './dependencyScanner';
import { getParsedDocument } from './verilogParser';

// 获取光标前的单词范围（至少一个字符）
function getWordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
    const line = document.lineAt(position.line).text;
    let start = position.character;
    while (start > 0 && /[a-zA-Z0-9_]/.test(line[start - 1])) start--;
    let end = position.character;
    while (end < line.length && /[a-zA-Z0-9_]/.test(line[end])) end++;
    if (start === end) return undefined;
    return new vscode.Range(position.line, start, position.line, end);
}

// 获取光标前的字符
function getCharBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    const line = document.lineAt(position.line).text;
    if (position.character > 0) return line[position.character - 1];
    return '';
}

// 辅助函数：判断光标是否在参数列表 `#(...)` 内
function isInParameterList(instNode: any, position: vscode.Position, document: vscode.TextDocument): boolean {
    const offset = document.offsetAt(position);
    // 查找 parameter_value_assignment 节点
    const paramValueNode = instNode.children.find((c: any) => c.type === 'parameter_value_assignment');
    if (paramValueNode) {
        const start = paramValueNode.startIndex;
        const end = paramValueNode.endIndex;
        if (offset >= start && offset <= end) {
            return true;
        }
    }
    return false;
}

// 从 AST 中查找光标位置所在的模块实例化节点
function findModuleInstantiationNodeAtPosition(rootNode: any, position: vscode.Position, document: vscode.TextDocument): any | undefined {
    const offset = document.offsetAt(position);
    let foundNode: any = null;
    const search = (node: any) => {
        if (foundNode) return;
        if (node.type === 'module_instantiation' || node.type === 'checker_instantiation' || node.type === 'program_instantiation') {
            const start = node.startIndex;
            const end = node.endIndex;
            if (offset >= start && offset <= end) {
                foundNode = node;
                return;
            }
        }
        for (const child of node.children) {
            search(child);
            if (foundNode) break;
        }
    };
    search(rootNode);
    return foundNode;
}

// 从模块实例化节点中提取模块名
function getModuleNameFromNode(node: any): string | undefined {
    const findModuleName = (n: any): string | undefined => {
        if (n.type === 'simple_identifier') return n.text;
        for (const child of n.children) {
            const res = findModuleName(child);
            if (res) return res;
        }
        return undefined;
    };
    return findModuleName(node);
}

export function createCompletionProvider(
    parser: Parser,
    srcScanner: DependencyScanner,
    simScanner: DependencyScanner,
    socScanner: DependencyScanner
): vscode.CompletionItemProvider {
    return {
        async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
            const charBefore = getCharBeforeCursor(document, position);
            const wordRangeAtPos = getWordRange(document, position);
            const wordBefore = wordRangeAtPos ? document.getText(wordRangeAtPos) : '';

            // 1. 模块名补全（输入字母）
            if (wordBefore.length > 0 && charBefore.match(/[a-zA-Z0-9_]/)) {
                const allModules = new Map<string, ModuleInfo>();
                for (const scanner of [srcScanner, simScanner, socScanner]) {
                    for (const [name, info] of scanner.getModules()) {
                        if (info.kind === 'module') {
                            allModules.set(name, info);
                        }
                    }
                }
                const items: vscode.CompletionItem[] = [];
                for (const [name, info] of allModules) {
                    if (name.toLowerCase().startsWith(wordBefore.toLowerCase())) {
                        const wordRange = getWordRange(document, position);
                        if (!wordRange) continue;
                        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
                        item.detail = `Module: ${name}`;
                        item.documentation = `Defined in: ${info.file}`;
                        item.insertText = '';
                        item.command = {
                            command: 'verilog.completeModuleInstantiation',
                            title: 'Instantiate Module',
                            arguments: [name, document.uri.toString(), wordRange.start.line, wordRange.start.character, wordRange.end.character]
                        };
                        items.push(item);
                    }
                }
                if (items.length > 0) return items;
            }

            // 2. 端口/参数补全（输入 '.'）
            if (charBefore === '.') {
                try {
                    const parsed = await getParsedDocument(document, parser);
                    const rootNode = parsed.rootNode;
                    const instNode = findModuleInstantiationNodeAtPosition(rootNode, position, document);
                    if (instNode) {
                        const moduleName = getModuleNameFromNode(instNode);
                        if (moduleName) {
                            let moduleInfo: ModuleInfo | undefined;
                            for (const scanner of [srcScanner, simScanner, socScanner]) {
                                const info = scanner.getModules().get(moduleName);
                                if (info && info.kind === 'module') {
                                    moduleInfo = info;
                                    break;
                                }
                            }
                            if (moduleInfo) {
                                const lineText = document.lineAt(position.line).text;
                                let dotPos = position.character - 1;
                                while (dotPos >= 0 && lineText[dotPos] !== '.') dotPos--;
                                if (dotPos < 0) return undefined;
                                const replaceRange = new vscode.Range(position.line, dotPos, position.line, position.character);
                                const isParameter = isInParameterList(instNode, position, document);
                                const allNames = isParameter 
                                    ? (moduleInfo.parameters?.map(p => p.name) || [])
                                    : (moduleInfo.ports?.map(p => p.name) || []);
                                const items: vscode.CompletionItem[] = [];
                                if (isParameter) {
                                    for (const param of moduleInfo.parameters || []) {
                                        const item = new vscode.CompletionItem(param.name, vscode.CompletionItemKind.Variable);
                                        item.detail = `Parameter: ${param.name}`;
                                        item.documentation = `Default: ${param.default || '?'}`;
                                        item.insertText = '';
                                        item.command = {
                                            command: 'verilog.insertPortConnection',
                                            title: 'Insert Port Connection',
                                            arguments: [document.uri.toString(), replaceRange, param.name, allNames]
                                        };
                                        items.push(item);
                                    }
                                } else {
                                    for (const port of moduleInfo.ports || []) {
                                        const item = new vscode.CompletionItem(port.name, vscode.CompletionItemKind.Field);
                                        item.detail = `${port.direction} ${port.type}${port.width ? ' ' + port.width : ''}`;
                                        item.insertText = '';
                                        item.command = {
                                            command: 'verilog.insertPortConnection',
                                            title: 'Insert Port Connection',
                                            arguments: [document.uri.toString(), replaceRange, port.name, allNames]
                                        };
                                        items.push(item);
                                    }
                                }
                                return items;
                            }
                        }
                    }
                } catch (e) {
                    console.error('Completion provider error:', e);
                }
            }

            return undefined;
        }
    };
}
