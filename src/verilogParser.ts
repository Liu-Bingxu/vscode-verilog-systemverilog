import * as vscode from 'vscode';
import { Parser } from 'web-tree-sitter';

// 符号信息（用于悬停和定义）
export interface SymbolInfo {
    name: string;
    kind: 'port' | 'param' | 'signal';
    direction?: string;      // 仅端口
    type?: string;           // 数据类型
    packedWidth?: string;    // 打包维度，如 [7:0]
    unpackedWidth?: string;  // 解包维度，如 [15:0]
    value?: string;          // 参数默认值
    line: number;
    column: number;
    file: string;
}

// 解析后的文档内容
export interface ParsedDocument {
    uri: string;
    version: number;
    documentSymbols: vscode.DocumentSymbol[];  // 大纲符号树
    symbols: SymbolInfo[];                     // 扁平符号列表（用于悬停/定义）
    lastAccessTime: number;
}

// 缓存管理器
class DocumentCache {
    private cache = new Map<string, ParsedDocument>();
    private cleanupTimer: NodeJS.Timeout;
    private readonly maxAge: number; // 毫秒

    constructor(maxAgeMs: number = 5 * 60 * 1000) { // 默认5分钟
        this.maxAge = maxAgeMs;
        this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 1000); // 每分钟检查一次
    }

    private cleanup() {
        const now = Date.now();
        for (const [uri, doc] of this.cache.entries()) {
            if (now - doc.lastAccessTime > this.maxAge) {
                this.cache.delete(uri);
            }
        }
    }

    get(uri: string): ParsedDocument | undefined {
        const doc = this.cache.get(uri);
        if (doc) {
            doc.lastAccessTime = Date.now();
            return doc;
        }
        return undefined;
    }

    set(uri: string, doc: ParsedDocument) {
        this.cache.set(uri, doc);
    }

    dispose() {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        this.cache.clear();
    }
}

// 全局缓存实例
const cache = new DocumentCache();

// 辅助函数
function findChild(node: any, type: string): any {
    return node.children?.find((c: any) => c.type === type);
}

function nodeToRange(node: any): vscode.Range {
    if (!node) return new vscode.Range(0, 0, 0, 0);
    return new vscode.Range(
        node.startPosition.row,
        node.startPosition.column,
        node.endPosition.row,
        node.endPosition.column
    );
}

function getGenerateBlockLabel(generateBlockNode: any): string {
    const blockIdNode = findChild(generateBlockNode, 'generate_block_identifier');
    if (blockIdNode) return blockIdNode.text;
    return '';
}

// 收集大纲符号（递归构建 DocumentSymbol 树）
function collectDocumentSymbols(node: any, parentSymbol: vscode.DocumentSymbol | null, symbols: vscode.DocumentSymbol[], topLevelSymbols: vscode.DocumentSymbol[]) {
    let symbolKind: vscode.SymbolKind | undefined;
    let name = '';
    let range: vscode.Range | undefined;
    let selectionRange: vscode.Range | undefined;

    // 模块声明
    if (node.type === 'module_declaration') {
        symbolKind = vscode.SymbolKind.Module;
        const header = findChild(node, 'module_header');
        if (header) {
            const nameNode = findChild(header, 'simple_identifier');
            if (nameNode) name = nameNode.text;
        }
        range = nodeToRange(node);
        selectionRange = nodeToRange(findChild(node, 'module_header') || node);
    }
    // 接口声明
    else if (node.type === 'interface_declaration') {
        symbolKind = vscode.SymbolKind.Interface;
        const ansiHeader = findChild(node, 'interface_ansi_header');
        if (ansiHeader) {
            const nameNode = findChild(ansiHeader, 'interface_identifier');
            if (nameNode) {
                const simpleId = findChild(nameNode, 'simple_identifier');
                if (simpleId) name = simpleId.text;
            }
        }
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 包声明
    else if (node.type === 'package_declaration') {
        symbolKind = vscode.SymbolKind.Package;
        const nameNode = findChild(node, 'package_identifier');
        if (nameNode) {
            const simpleId = findChild(nameNode, 'simple_identifier');
            if (simpleId) name = simpleId.text;
        }
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 任务声明
    else if (node.type === 'task_declaration') {
        symbolKind = vscode.SymbolKind.Method;
        const body = findChild(node, 'task_body_declaration');
        if (body) {
            const nameNode = findChild(body, 'task_identifier');
            if (nameNode) {
                const simpleId = findChild(nameNode, 'simple_identifier');
                if (simpleId) name = simpleId.text;
            }
        }
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 函数声明
    else if (node.type === 'function_declaration') {
        symbolKind = vscode.SymbolKind.Function;
        const body = findChild(node, 'function_body_declaration');
        if (body) {
            const nameNode = findChild(body, 'function_identifier');
            if (nameNode) {
                const simpleId = findChild(nameNode, 'simple_identifier');
                if (simpleId) name = simpleId.text;
            }
        }
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 模块实例化（包括 program_instantiation）
    else if ((node.type === 'module_instantiation' || node.type === 'program_instantiation') && parentSymbol) {
        symbolKind = vscode.SymbolKind.Object;
        const hierarchical = findChild(node, 'hierarchical_instance');
        if (hierarchical) {
            const nameNode = findChild(hierarchical, 'name_of_instance');
            if (nameNode) {
                const idNode = findChild(nameNode, 'instance_identifier');
                if (idNode) {
                    const simpleId = findChild(idNode, 'simple_identifier');
                    if (simpleId) name = simpleId.text;
                }
            }
        }
        if (!name) name = 'instance';
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 接口实例化
    else if (node.type === 'interface_instantiation' && parentSymbol) {
        symbolKind = vscode.SymbolKind.Object;
        const hierarchical = findChild(node, 'hierarchical_instance');
        if (hierarchical) {
            const nameNode = findChild(hierarchical, 'name_of_instance');
            if (nameNode) {
                const idNode = findChild(nameNode, 'instance_identifier');
                if (idNode) {
                    const simpleId = findChild(idNode, 'simple_identifier');
                    if (simpleId) name = simpleId.text;
                }
            }
        }
        if (!name) name = 'interface_instance';
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 断言检查器实例化
    else if (node.type === 'checker_instantiation' && parentSymbol) {
        symbolKind = vscode.SymbolKind.Object;
        const nameOfInstance = findChild(node, 'name_of_instance');
        if (nameOfInstance) {
            const idNode = findChild(nameOfInstance, 'instance_identifier');
            if (idNode) {
                const simpleId = findChild(idNode, 'simple_identifier');
                if (simpleId) name = simpleId.text;
            }
        }
        if (!name) name = 'checker_instance';
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 包导入声明
    else if (node.type === 'package_import_declaration' && parentSymbol) {
        symbolKind = vscode.SymbolKind.Package;
        const packageItem = findChild(node, 'package_import_item');
        if (packageItem) {
            const pkgNode = findChild(packageItem, 'package_identifier');
            if (pkgNode) {
                const simpleId = findChild(pkgNode, 'simple_identifier');
                if (simpleId) name = simpleId.text;
            }
        }
        if (!name) name = 'import';
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 端口声明（作为模块的子符号）
    else if (node.type === 'ansi_port_declaration' && parentSymbol && parentSymbol.kind === vscode.SymbolKind.Module) {
        symbolKind = vscode.SymbolKind.Field;
        const portIdNode = findChild(node, 'port_identifier');
        if (portIdNode) {
            const simpleId = findChild(portIdNode, 'simple_identifier');
            if (simpleId) name = simpleId.text;
        }
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
    }
    // 参数声明（包括模块头部参数和内部 parameter_declaration / local_parameter_declaration）
    else if ((node.type === 'parameter_declaration' || node.type === 'local_parameter_declaration') && parentSymbol) {
        if (parentSymbol.kind === vscode.SymbolKind.Module || parentSymbol.kind === vscode.SymbolKind.Namespace) {
            const listNode = findChild(node, 'list_of_param_assignments');
            if (listNode) {
                const paramAssigns = listNode.children.filter((c: any) => c.type === 'param_assignment');
                for (const assign of paramAssigns) {
                    const nameNode = findChild(assign, 'parameter_identifier');
                    if (nameNode) {
                        const simpleId = findChild(nameNode, 'simple_identifier');
                        if (simpleId) {
                            const symName = simpleId.text;
                            const symKind = vscode.SymbolKind.Variable;
                            const symRange = nodeToRange(node);
                            const symSelection = nodeToRange(simpleId);
                            const symbol = new vscode.DocumentSymbol(symName, '', symKind, symRange, symSelection);
                            parentSymbol.children.push(symbol);
                        }
                    }
                }
            }
            return; // 已处理子节点
        }
    }
    // 数据声明（wire/reg/logic）
    else if (node.type === 'data_declaration' && parentSymbol) {
        if (parentSymbol.kind === vscode.SymbolKind.Module || parentSymbol.kind === vscode.SymbolKind.Namespace) {
            const listNode = findChild(node, 'list_of_variable_decl_assignments');
            if (listNode) {
                const decls = listNode.children.filter((c: any) => c.type === 'variable_decl_assignment');
                for (const decl of decls) {
                    const nameNode = findChild(decl, 'simple_identifier');
                    if (nameNode) {
                        const symName = nameNode.text;
                        const symKind = vscode.SymbolKind.Variable;
                        const symRange = nodeToRange(node);
                        const symSelection = nodeToRange(nameNode);
                        const symbol = new vscode.DocumentSymbol(symName, '', symKind, symRange, symSelection);
                        parentSymbol.children.push(symbol);
                    }
                }
            }
            return;
        }
    }
    // genvar 声明
    else if (node.type === 'genvar_declaration' && parentSymbol) {
        if (parentSymbol.kind === vscode.SymbolKind.Module || parentSymbol.kind === vscode.SymbolKind.Namespace) {
            const listNode = findChild(node, 'list_of_genvar_identifiers');
            if (listNode) {
                const ids = listNode.children.filter((c: any) => c.type === 'genvar_identifier');
                for (const idNode of ids) {
                    const simpleId = findChild(idNode, 'simple_identifier');
                    if (simpleId) {
                        const symName = simpleId.text;
                        const symKind = vscode.SymbolKind.Variable;
                        const symRange = nodeToRange(node);
                        const symSelection = nodeToRange(simpleId);
                        const symbol = new vscode.DocumentSymbol(symName, '', symKind, symRange, symSelection);
                        parentSymbol.children.push(symbol);
                    }
                }
            }
            return;
        }
    }
    // 自定义类型声明（net_declaration）
    else if (node.type === 'net_declaration' && parentSymbol) {
        if (parentSymbol.kind === vscode.SymbolKind.Module || parentSymbol.kind === vscode.SymbolKind.Namespace) {
            const listNode = findChild(node, 'list_of_net_decl_assignments');
            if (listNode) {
                const decls = listNode.children.filter((c: any) => c.type === 'net_decl_assignment');
                for (const decl of decls) {
                    const nameNode = findChild(decl, 'simple_identifier');
                    if (nameNode) {
                        const symName = nameNode.text;
                        const symKind = vscode.SymbolKind.Variable;
                        const symRange = nodeToRange(node);
                        const symSelection = nodeToRange(nameNode);
                        const symbol = new vscode.DocumentSymbol(symName, '', symKind, symRange, symSelection);
                        parentSymbol.children.push(symbol);
                    }
                }
            }
            return;
        }
    }
    // generate 区域
    else if (node.type === 'generate_region' && parentSymbol && parentSymbol.kind === vscode.SymbolKind.Module) {
        symbolKind = vscode.SymbolKind.Namespace;
        name = 'generate';
        range = nodeToRange(node);
        selectionRange = nodeToRange(node);
        const generateSymbol = new vscode.DocumentSymbol(name, '', symbolKind, range, selectionRange);
        if (parentSymbol) {
            parentSymbol.children.push(generateSymbol);
        } else {
            topLevelSymbols.push(generateSymbol);
        }
        for (const child of node.children) {
            collectDocumentSymbols(child, generateSymbol, symbols, topLevelSymbols);
        }
        return;
    }
    // generate_block（有标签的）
    else if (node.type === 'generate_block') {
        const label = getGenerateBlockLabel(node);
        if (label) {
            symbolKind = vscode.SymbolKind.Namespace;
            name = label;
            range = nodeToRange(node);
            selectionRange = nodeToRange(node);
        } else {
            // 无标签的 generate_block 不创建符号，但继续递归
            for (const child of node.children) {
                collectDocumentSymbols(child, parentSymbol, symbols, topLevelSymbols);
            }
            return;
        }
    }

    if (symbolKind !== undefined && name && range && selectionRange) {
        const symbol = new vscode.DocumentSymbol(name, '', symbolKind, range, selectionRange);
        if (parentSymbol) {
            parentSymbol.children.push(symbol);
        } else {
            topLevelSymbols.push(symbol);
        }
        for (const child of node.children) {
            collectDocumentSymbols(child, symbol, symbols, topLevelSymbols);
        }
    } else {
        for (const child of node.children) {
            collectDocumentSymbols(child, parentSymbol, symbols, topLevelSymbols);
        }
    }
}

// 收集悬停/定义用的符号列表
function collectSymbolInfo(node: any, filePath: string, symbols: SymbolInfo[]) {
    // 1. 端口声明
    if (node.type === 'module_ansi_header') {
        const portList = findChild(node, 'list_of_port_declarations');
        if (portList) {
            const portDecls = portList.children.filter((c: any) => c.type === 'ansi_port_declaration');
            for (const decl of portDecls) {
                let direction = 'input';
                let type = '';
                let packedWidth = '';
                let portHeader = findChild(decl, 'net_port_header1');
                let isNet = true;
                if (!portHeader) {
                    portHeader = findChild(decl, 'variable_port_header');
                    isNet = false;
                }
                if (portHeader) {
                    const dirNode = findChild(portHeader, 'port_direction');
                    if (dirNode) {
                        const dirChild = dirNode.children.find((c: any) => c.type === 'input' || c.type === 'output' || c.type === 'inout');
                        if (dirChild) direction = dirChild.type;
                    }
                    if (!isNet) {
                        const dataTypeNode = findChild(portHeader, 'data_type');
                        if (dataTypeNode) {
                            const intVec = findChild(dataTypeNode, 'integer_vector_type');
                            const selfType = findChild(dataTypeNode, 'simple_identifier');
                            if (intVec) type = intVec.text;
                            else if (selfType) type = selfType.text;
                            const dim = findChild(dataTypeNode, 'packed_dimension');
                            if (dim) packedWidth = dim.text;
                        }
                    } else {
                        const selfType = findChild(portHeader, 'net_port_type1');
                        type = 'wire';
                        if (selfType) type = selfType.text;
                        const dim = findChild(portHeader, 'packed_dimension');
                        if (dim) packedWidth = dim.text;
                    }
                }
                const portIdNode = findChild(decl, 'port_identifier');
                if (portIdNode) {
                    const simpleId = findChild(portIdNode, 'simple_identifier');
                    if (simpleId) {
                        symbols.push({
                            name: simpleId.text,
                            kind: 'port',
                            direction,
                            type,
                            packedWidth,
                            unpackedWidth: '',
                            line: simpleId.startPosition.row,
                            column: simpleId.startPosition.column,
                            file: filePath
                        });
                    }
                }
            }
        }
    }

    // 2. 模块参数（parameter_port_list）
    if (node.type === 'parameter_port_list') {
        const paramDecls = node.children.filter((c: any) => c.type === 'parameter_port_declaration');
        for (const decl of paramDecls) {
            let paramDeclNode = findChild(decl, 'parameter_declaration') || findChild(decl, 'local_parameter_declaration');
            if (paramDeclNode) {
                const listNode = findChild(paramDeclNode, 'list_of_param_assignments');
                if (listNode) {
                    const assigns = listNode.children.filter((c: any) => c.type === 'param_assignment');
                    for (const assign of assigns) {
                        const nameNode = findChild(assign, 'parameter_identifier');
                        if (nameNode) {
                            const simpleId = findChild(nameNode, 'simple_identifier');
                            if (simpleId) {
                                const valueNode = findChild(assign, 'constant_param_expression');
                                const value = valueNode ? valueNode.text : '';
                                symbols.push({
                                    name: simpleId.text,
                                    kind: 'param',
                                    type: 'parameter',
                                    value,
                                    line: simpleId.startPosition.row,
                                    column: simpleId.startPosition.column,
                                    file: filePath
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. 内部数据声明
    if (node.type === 'data_declaration') {
        let dataType = '';
        let packedWidth = '';
        const dataTypeOrImplicit = findChild(node, 'data_type_or_implicit1');
        if (dataTypeOrImplicit) {
            const dataTypeNode = findChild(dataTypeOrImplicit, 'data_type');
            if (dataTypeNode) {
                const intVec = findChild(dataTypeNode, 'integer_vector_type');
                const selfType = findChild(dataTypeNode, 'simple_identifier');
                if (intVec) dataType = intVec.text;
                else if (selfType) dataType = selfType.text;
                const dim = findChild(dataTypeNode, 'packed_dimension');
                if (dim) packedWidth = dim.text;
            } else {
                const implicit = findChild(dataTypeOrImplicit, 'implicit_data_type1');
                if (implicit) {
                    dataType = 'wire';
                    const dim = findChild(implicit, 'packed_dimension');
                    if (dim) packedWidth = dim.text;
                }
            }
        } else {
            dataType = 'wire';
        }
        const listNode = findChild(node, 'list_of_variable_decl_assignments');
        if (listNode) {
            const decls = listNode.children.filter((c: any) => c.type === 'variable_decl_assignment');
            for (const decl of decls) {
                const nameNode = findChild(decl, 'simple_identifier');
                if (nameNode) {
                    let unpackedWidth = '';
                    const unpackedDim = findChild(decl, 'unpacked_dimension');
                    if (unpackedDim) unpackedWidth = unpackedDim.text;
                    symbols.push({
                        name: nameNode.text,
                        kind: 'signal',
                        type: dataType,
                        packedWidth,
                        unpackedWidth,
                        line: nameNode.startPosition.row,
                        column: nameNode.startPosition.column,
                        file: filePath
                    });
                }
            }
        }
    }

    // 4. 参数声明（parameter_declaration）
    if (node.type === 'parameter_declaration') {
        const listNode = findChild(node, 'list_of_param_assignments');
        if (listNode) {
            const paramAssigns = listNode.children.filter((c: any) => c.type === 'param_assignment');
            for (const assign of paramAssigns) {
                const nameNode = findChild(assign, 'parameter_identifier');
                if (nameNode) {
                    const simpleId = findChild(nameNode, 'simple_identifier');
                    if (simpleId) {
                        const valueNode = findChild(assign, 'constant_param_expression');
                        const value = valueNode ? valueNode.text : '';
                        symbols.push({
                            name: simpleId.text,
                            kind: 'param',
                            type: 'parameter',
                            value,
                            line: simpleId.startPosition.row,
                            column: simpleId.startPosition.column,
                            file: filePath
                        });
                    }
                }
            }
        }
    }

    // 5. 局部参数声明
    if (node.type === 'local_parameter_declaration') {
        const listNode = findChild(node, 'list_of_param_assignments');
        if (listNode) {
            const paramAssigns = listNode.children.filter((c: any) => c.type === 'param_assignment');
            for (const assign of paramAssigns) {
                const nameNode = findChild(assign, 'parameter_identifier');
                if (nameNode) {
                    const simpleId = findChild(nameNode, 'simple_identifier');
                    if (simpleId) {
                        const valueNode = findChild(assign, 'constant_param_expression');
                        const value = valueNode ? valueNode.text : '';
                        symbols.push({
                            name: simpleId.text,
                            kind: 'param',
                            type: 'localparam',
                            value,
                            line: simpleId.startPosition.row,
                            column: simpleId.startPosition.column,
                            file: filePath
                        });
                    }
                }
            }
        }
    }

    // 6. genvar 声明
    if (node.type === 'genvar_declaration') {
        const listNode = findChild(node, 'list_of_genvar_identifiers');
        if (listNode) {
            const ids = listNode.children.filter((c: any) => c.type === 'genvar_identifier');
            for (const idNode of ids) {
                const simpleId = findChild(idNode, 'simple_identifier');
                if (simpleId) {
                    symbols.push({
                        name: simpleId.text,
                        kind: 'signal',
                        type: 'genvar',
                        packedWidth: '',
                        unpackedWidth: '',
                        line: simpleId.startPosition.row,
                        column: simpleId.startPosition.column,
                        file: filePath
                    });
                }
            }
        }
    }

    // 7. 自定义类型声明
    if (node.type === 'net_declaration') {
        const typeNode = findChild(node, 'simple_identifier');
        let dataType = typeNode ? typeNode.text : 'wire';
        const listNode = findChild(node, 'list_of_net_decl_assignments');
        if (listNode) {
            const decls = listNode.children.filter((c: any) => c.type === 'net_decl_assignment');
            for (const decl of decls) {
                const nameNode = findChild(decl, 'simple_identifier');
                if (nameNode) {
                    let unpackedWidth = '';
                    const unpackedDim = findChild(decl, 'unpacked_dimension');
                    if (unpackedDim) unpackedWidth = unpackedDim.text;
                    symbols.push({
                        name: nameNode.text,
                        kind: 'signal',
                        type: dataType,
                        packedWidth: '',
                        unpackedWidth,
                        line: nameNode.startPosition.row,
                        column: nameNode.startPosition.column,
                        file: filePath
                    });
                }
            }
        }
    }

    // 递归子节点
    for (const child of node.children) {
        collectSymbolInfo(child, filePath, symbols);
    }
}

// 解析文档并构建缓存
export async function getParsedDocument(document: vscode.TextDocument, parser: Parser): Promise<ParsedDocument> {
    const uri = document.uri.toString();
    const version = document.version;
    const cached = cache.get(uri);
    if (cached && cached.version === version) {
        return cached;
    }

    let text = document.getText();
    // 预处理：移除 static_assert 和 $error 行，避免解析器出错
    text = text.replace(/^\s*static_assert\s*\([^;]*\)\s*;/gm, '// static_assert(...)');
    text = text.replace(/^\s*\$error\s*\([^;]*\)\s*;/gm, '// $error(...)');

    const tree = parser.parse(text);
    if (!tree) {
        throw new Error('Failed to parse document');
    }

    // 收集大纲符号
    const topLevelSymbols: vscode.DocumentSymbol[] = [];
    collectDocumentSymbols(tree.rootNode, null, topLevelSymbols, topLevelSymbols);

    // 收集悬停/定义符号
    const symbols: SymbolInfo[] = [];
    const filePath = document.uri.fsPath;
    collectSymbolInfo(tree.rootNode, filePath, symbols);

    const parsed: ParsedDocument = {
        uri,
        version,
        documentSymbols: topLevelSymbols,
        symbols,
        lastAccessTime: Date.now()
    };
    cache.set(uri, parsed);
    return parsed;
}

// 释放缓存（可选，用于插件 deactivate 时）
export function disposeCache() {
    cache.dispose();
}
