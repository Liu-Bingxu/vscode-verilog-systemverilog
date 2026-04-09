import { Parser } from 'web-tree-sitter';
import * as vscode from 'vscode';

export class VerilogDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    private parser: Parser;

    constructor(parser: Parser) {
        this.parser = parser;
    }

    async provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
        let text = document.getText();
        if (!text.trim()) return [];
        // 预处理：将 static_assert 和 $error 行替换为注释
        if (this.parser) {
            // 匹配行首任意空白后跟 static_assert 或 $error，直到分号结束（包含可能的多行？）
            // 这里简化：替换单行，假设 static_assert 和 $error 不跨行（Verilog 允许跨行，但较少见）
            text = text.replace(/^\s*static_assert\s*\([^;]*\)\s*;/gm, '// static_assert(...)');
            text = text.replace(/^\s*\$error\s*\([^;]*\)\s*;/gm, '// $error(...)');
        }

        const tree = this.parser.parse(text);
        if (!tree) return [];

        const symbols: vscode.DocumentSymbol[] = [];

        const findChild = (node: any, type: string): any => {
            return node.children?.find((c: any) => c.type === type);
        };

        const nodeToRange = (node: any): vscode.Range => {
            if (!node) return new vscode.Range(0, 0, 0, 0);
            return new vscode.Range(
                node.startPosition.row,
                node.startPosition.column,
                node.endPosition.row,
                node.endPosition.column
            );
        };

        const getGenerateBlockLabel = (generateBlockNode: any): string => {
            const blockIdNode = findChild(generateBlockNode, 'generate_block_identifier');
            if (blockIdNode) {
                return blockIdNode.text;
            }
            return '';
        };

        const visit = (node: any, parentSymbol: vscode.DocumentSymbol | null) => {
            let symbolKind: vscode.SymbolKind | undefined;
            let name = '';
            let range: vscode.Range | undefined;
            let selectionRange: vscode.Range | undefined;

            // 1. 模块声明
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
            // 2. 接口声明
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
            // 3. 包声明
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
            // 4. 任务声明
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
            // 5. 函数声明
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
            // 6. 模块实例化（包括 program_instantiation）
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
            // 7. 接口实例化
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
            // 8. 断言检查器实例化
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
            // 9. 包导入声明
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
            // 10. 端口声明（作为模块的子符号）
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
            // 11. 参数声明（包括模块头部参数和内部 parameter_declaration / local_parameter_declaration）
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
                    // 不递归子节点，避免重复
                    return;
                }
            }
            // 12. 数据声明（wire/reg/logic，可作为模块或 generate 块的子符号）
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
                    // 不递归子节点
                    return;
                }
            }
            // 13. genvar 声明
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
                    // 不递归子节点
                    return;
                }
            }
            // 14. 自定义类型声明（net_declaration）
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
                    // 不递归子节点
                    return;
                }
            }
            // 15. generate 区域
            else if (node.type === 'generate_region' && parentSymbol && parentSymbol.kind === vscode.SymbolKind.Module) {
                symbolKind = vscode.SymbolKind.Namespace;
                name = 'generate';
                range = nodeToRange(node);
                selectionRange = nodeToRange(node);
                const generateSymbol = new vscode.DocumentSymbol(name, '', symbolKind, range, selectionRange);
                if (parentSymbol) {
                    parentSymbol.children.push(generateSymbol);
                } else {
                    symbols.push(generateSymbol);
                }
                for (const child of node.children) {
                    visit(child, generateSymbol);
                }
                return;
            }
            // 16. generate_block（有标签的）
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
                        visit(child, parentSymbol);
                    }
                    return;
                }
            }

            if (symbolKind !== undefined && name && range && selectionRange) {
                const symbol = new vscode.DocumentSymbol(name, '', symbolKind, range, selectionRange);
                if (parentSymbol) {
                    parentSymbol.children.push(symbol);
                } else {
                    symbols.push(symbol);
                }
                for (const child of node.children) {
                    visit(child, symbol);
                }
            } else {
                for (const child of node.children) {
                    visit(child, parentSymbol);
                }
            }
        };

        visit(tree.rootNode, null);
        return symbols;
    }
}
