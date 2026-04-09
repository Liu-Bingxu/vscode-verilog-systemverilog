import * as vscode from 'vscode';
import { Parser } from 'web-tree-sitter';
import { DependencyScanner } from './dependencyScanner';

interface SymbolInfo {
    name: string;
    kind: 'port' | 'param' | 'signal';
    direction?: string;
    type?: string;
    packedWidth?: string;   // 打包维度，如 [7:0]
    unpackedWidth?: string; // 解包维度，如 [15:0]
    value?: string;         // 参数默认值
    line: number;
    column: number;
    file: string;
}

export function createHoverProvider(
    parser: Parser,
    srcScanner: DependencyScanner,
    simScanner: DependencyScanner,
    socScanner: DependencyScanner
): vscode.HoverProvider {
    return {
        provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_$]*/);
            if (!wordRange) return null;
            const word = document.getText(wordRange);
            if (!word) return null;

            const text = document.getText();
            const tree = parser.parse(text);
            if (!tree) return null;

            const findChild = (node: any, type: string): any => {
                return node.children?.find((c: any) => c.type === type);
            };

            // 查找包含光标的模块节点
            let targetModuleNode: any = null;
            const findModule = (node: any): void => {
                if (node.type === 'module_declaration') {
                    const start = node.startPosition.row;
                    const end = node.endPosition.row;
                    if (position.line >= start && position.line <= end) {
                        targetModuleNode = node;
                        return;
                    }
                }
                for (const child of node.children) {
                    findModule(child);
                    if (targetModuleNode) break;
                }
            };
            findModule(tree.rootNode);
            if (!targetModuleNode) return null;

            const moduleFile = document.uri.fsPath;
            const symbols: SymbolInfo[] = [];

            const collectSymbols = (node: any) => {
                // 1. 端口声明（module_ansi_header 内）
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
                                        const self_type = findChild(dataTypeNode, 'simple_identifier');
                                        if (intVec) type = intVec.text;
                                        else if (self_type) type = self_type.text;
                                        const dim = findChild(dataTypeNode, 'packed_dimension');
                                        if (dim) packedWidth = dim.text;
                                    }
                                } else {
                                    const self_type = findChild(portHeader, 'net_port_type1');
                                    type = 'wire';
                                    if (self_type) type = self_type.text;
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
                                        file: moduleFile
                                    });
                                }
                            }
                        }
                    }
                }

                // 2. 模块参数（parameter_port_list 内）
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
                                                file: moduleFile
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // 3. 内部数据声明（data_declaration）
                if (node.type === 'data_declaration') {
                    let dataType = '';
                    let packedWidth = '';
                    // 获取 data_type_or_implicit1
                    const dataTypeOrImplicit = findChild(node, 'data_type_or_implicit1');
                    if (dataTypeOrImplicit) {
                        const dataTypeNode = findChild(dataTypeOrImplicit, 'data_type');
                        if (dataTypeNode) {
                            const intVec = findChild(dataTypeNode, 'integer_vector_type');
                            const self_type = findChild(dataTypeNode, 'simple_identifier');
                            if (intVec) dataType = intVec.text;
                            else if(self_type)dataType = self_type.text;
                            const dim = findChild(dataTypeNode, 'packed_dimension');
                            if (dim) packedWidth = dim.text;
                        } else {
                            // implicit_data_type1 (如 wire)
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
                    // 获取变量赋值列表
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
                                    file: moduleFile
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
                                        file: moduleFile
                                    });
                                }
                            }
                        }
                    }
                }

                // 5. 局部参数声明（local_parameter_declaration）
                if (node.type === 'local_parameter_declaration') {
                    const listNode = findChild(node, 'list_of_param_assignments');
                    if (listNode) {
                        const paramAssigns = listNode.children.filter((c: any) => c.type === 'param_assignment');
                        for (const assign of paramAssigns) {
                            const nameNode = findChild(assign, 'parameter_identifier');
                            if (nameNode) {
                                const valueNode = findChild(assign, 'constant_param_expression');
                                const value = valueNode ? valueNode.text : '';
                                const simpleId = findChild(nameNode, 'simple_identifier');
                                if (simpleId) {
                                    symbols.push({
                                        name: simpleId.text,
                                        kind: 'param',
                                        type: 'localparam',
                                        value,
                                        line: simpleId.startPosition.row,
                                        column: simpleId.startPosition.column,
                                        file: moduleFile
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
                                    file: moduleFile
                                });
                            }
                        }
                    }
                }

                // 7. 自定义类型声明（net_declaration）
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
                                    file: moduleFile
                                });
                            }
                        }
                    }
                }

                // 递归子节点
                for (const child of node.children) {
                    collectSymbols(child);
                }
            };

            collectSymbols(targetModuleNode);

            // 查找匹配的符号
            const matched = symbols.find(s => s.name === word);
            if (matched) {
                const markdown = new vscode.MarkdownString();
                let typeStr = '';
                if (matched.kind === 'port') {
                    const widthPart = matched.packedWidth ? ' ' + matched.packedWidth : '';
                    typeStr = `${matched.direction} ${matched.type} ${widthPart} ${matched.name}`;
                } else if (matched.kind === 'param') {
                    typeStr = `${matched.type} ${matched.name} = ${matched.value}`;
                } else { // signal
                    const packedPart = matched.packedWidth ? ' ' + matched.packedWidth : '';
                    const unpackedPart = matched.unpackedWidth ? ' ' + matched.unpackedWidth : '';
                    typeStr = `${matched.type} ${packedPart} ${matched.name} ${unpackedPart}`;
                }
                markdown.appendMarkdown(`**${word}**\n`);
                markdown.appendMarkdown(`- **Type**: ${typeStr}\n`);
                markdown.appendMarkdown(`- **Defined at**: ${matched.file}:${matched.line + 1}:${matched.column + 1}\n`);
                markdown.isTrusted = true;
                return new vscode.Hover(markdown);
            }

            // 跨文件模块实例化悬停
            const scanners = [srcScanner, simScanner, socScanner];
            for (const scanner of scanners) {
                const modules = scanner.getModules();
                const moduleInfo = modules.get(word);
                if (moduleInfo && moduleInfo.kind === 'module' && moduleInfo.file) {
                    const markdown = new vscode.MarkdownString();
                    markdown.appendMarkdown(`**Module: ${word}**\n`);
                    markdown.appendMarkdown(`- **Defined in**: ${moduleInfo.file}${moduleInfo.range ? `:${moduleInfo.range.line + 1}` : ''}\n`);
                    markdown.isTrusted = true;
                    return new vscode.Hover(markdown);
                }
            }

            return null;
        }
    };
}
